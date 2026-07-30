/**
 * B9b.4: AntiGhosting ingest service.
 *
 * Extracts the marking-flow logic (validators → prospect insert →
 * thread_messages sync → F1 schedule) into a reusable function so both
 * the POST /api/anti-ghosting/mark route handler AND the gmailSync
 * auto-ingest pass can call into the same code path.
 *
 * Also relocates the two helpers `resolveAntiGhostingLabelIds` and
 * `getAlreadyMarkedThreadIds` here so they're importable from sync
 * without crossing the routes ↔ services layering boundary.
 *
 * Design note: AntiGhosting was originally operator-driven (Mark button
 * in the dashboard). B9b.4 pivots to label-driven auto-ingest: the
 * operator labels a thread with `AntiGhosting Followuper` in Gmail, and
 * the next sync cycle automatically ingests it. The labeling step is
 * the manual commitment point. This matches how Doctrine and Context
 * already work and removes a redundant click from the workflow.
 *
 * The POST /mark endpoint stays in place as a manual override — useful
 * for force-ingesting a thread immediately without waiting for the next
 * sync cycle, or for passing a custom seedMessageId (operator picks a
 * different anchor message than the validator's auto-detected one).
 */

import { gmail_v1 } from "googleapis";
import { and, eq } from "drizzle-orm";
import {
  db,
  prospectsTable,
  followupsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  validateThreadForMarking,
  type ThreadMessageBrief,
  type ValidatorResults,
} from "./antiGhostingValidators";
import { computeFirstFollowupAt } from "./antiGhostingScheduling";
import { syncThreadFromGmail } from "./threadReader";

/**
 * Resolves the user's antiGhostingLabel setting (comma-separated names)
 * into a set of Gmail label IDs. Mirrors the doctrine/context label
 * resolution pattern: a name matches a Gmail label if it's a
 * case-insensitive equal OR the Gmail label name starts with `${name}/`
 * (nested sublabels). Returns an empty array if the user has no labels
 * matching anything in their mailbox.
 */
export async function resolveAntiGhostingLabelIds(
  gmail: gmail_v1.Gmail,
  labelSetting: string,
): Promise<string[]> {
  const names = (labelSetting || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  if (names.length === 0) return [];

  const labelsRes = await gmail.users.labels.list({ userId: "me" });
  const labels = labelsRes.data.labels || [];
  const matched: string[] = [];
  for (const label of labels) {
    if (!label.id || !label.name) continue;
    const lower = label.name.toLowerCase();
    if (names.some((n) => lower === n || lower.startsWith(`${n}/`))) {
      matched.push(label.id);
    }
  }
  return matched;
}

/**
 * 2026-07-29: list threads carrying ANY of the given label IDs.
 *
 * Gmail's threads.list `labelIds` parameter is an AND filter — a thread
 * must carry EVERY listed ID to match. resolveAntiGhostingLabelIds can
 * legitimately return several IDs (the label plus nested "Name/…"
 * sublabels, or several comma-separated names), and passing them
 * together silently returned only threads carrying ALL of them —
 * usually nothing, i.e. detection went dark the moment the operator
 * created a sublabel. This helper issues one list call per label and
 * unions the results (first occurrence wins, order preserved), which
 * is the OR semantics the label-setting has always advertised.
 */
export async function listThreadsWithAnyLabel(
  gmail: gmail_v1.Gmail,
  labelIds: string[],
  maxResults: number,
  options?: {
    /**
     * Thread ids to exclude BEFORE the cap is applied (typically the
     * already-marked set). Without this, a user with ≥maxResults labeled
     * threads has their listing window permanently filled by already-
     * ingested rows (AG labels are never removed post-ingest), so a newly
     * labeled but quiet old thread could sit outside the window forever.
     */
    skipThreadIds?: ReadonlySet<string>;
  },
): Promise<gmail_v1.Schema$Thread[]> {
  const skip = options?.skipThreadIds;
  const seen = new Set<string>();
  const threads: gmail_v1.Schema$Thread[] = [];
  // Hard per-label page bound so a mailbox with thousands of labeled
  // threads cannot turn one sync tick into an unbounded Gmail crawl.
  const MAX_PAGES_PER_LABEL = 10;
  for (const labelId of labelIds) {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_LABEL; page++) {
      const res = await gmail.users.threads.list({
        userId: "me",
        labelIds: [labelId],
        maxResults: Math.min(100, Math.max(maxResults, 25)),
        ...(pageToken ? { pageToken } : {}),
      });
      for (const t of res.data.threads ?? []) {
        if (!t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        if (skip?.has(t.id)) continue;
        threads.push(t);
        if (threads.length >= maxResults) return threads;
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
  }
  return threads;
}

/**
 * Returns the set of gmailThreadId values for which the user already
 * has an anti_ghosting prospect. Used by the auto-ingest pass to skip
 * threads we've already created prospects for, and by the candidates
 * endpoint to filter the preview list.
 */
export async function getAlreadyMarkedThreadIds(
  userId: number,
): Promise<Set<string>> {
  const rows = await db
    .select({ gmailThreadId: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .where(
      and(
        eq(prospectsTable.userId, userId),
        eq(prospectsTable.app, "anti_ghosting"),
      ),
    );
  const out = new Set<string>();
  for (const row of rows) {
    if (row.gmailThreadId) out.add(row.gmailThreadId);
  }
  return out;
}

/**
 * Result type for ingestAntiGhostingThread.
 *
 *  success:           true if the prospect was created and F1 scheduled.
 *  alreadyMarked:     true if a prospect already exists for this thread.
 *                     `prospectId` is populated with the existing row's id.
 *  reason:            populated on !success when the validators or a
 *                     seed-override check rejected the thread.
 *  validatorResults:  the three-validator output for preview rendering.
 *                     Populated on both pass and fail paths so callers
 *                     can show "which validator went red" in the UI.
 *  prospect:          the prospect identity extracted from the thread.
 *                     Populated whenever the validator was able to find
 *                     it, regardless of overall pass/fail.
 *  seed:              metadata about the seed message (success only).
 *  scheduledAt:       F1 dispatch time (success only).
 */
export interface IngestResult {
  success: boolean;
  alreadyMarked?: boolean;
  prospectId?: number;
  scheduledAt?: Date;
  reason?: string;
  validatorResults?: ValidatorResults;
  prospect?: { name: string; email: string };
  seed?: { gmailMessageId: string; subject: string; sentAt: Date };
}

/**
 * Core ingest function. Idempotent — calling twice for the same thread
 * returns `alreadyMarked: true` on the second call. Safe to invoke from
 * the sync pass (every cycle) without worrying about duplicates.
 *
 * Failure paths are non-throwing for everything the caller is expected
 * to recover from (validator rejection, override seed not found,
 * already-marked). Throws only for unexpected DB or Gmail-API errors,
 * which the caller should catch and log.
 */
export async function ingestAntiGhostingThread(args: {
  userId: number;
  gmail: gmail_v1.Gmail;
  userEmail: string;
  gmailThreadId: string;
  overrideSeedMessageId?: string;
}): Promise<IngestResult> {
  // 1. Idempotency: skip threads we've already ingested. Cheap per-row
  //    lookup, much cheaper than running the validators + Gmail reads.
  const existing = await db
    .select({ id: prospectsTable.id })
    .from(prospectsTable)
    .where(
      and(
        eq(prospectsTable.userId, args.userId),
        eq(prospectsTable.gmailThreadId, args.gmailThreadId),
        eq(prospectsTable.app, "anti_ghosting"),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return {
      success: false,
      alreadyMarked: true,
      prospectId: existing[0].id,
    };
  }

  // 2. Run the three validators.
  const outcome = await validateThreadForMarking(
    args.gmailThreadId,
    args.gmail,
    args.userEmail,
    args.userId,
  );

  if (!outcome.ok) {
    return {
      success: false,
      reason: outcome.failureReason ?? "validator rejected thread",
      validatorResults: outcome.results,
      prospect: outcome.prospect ?? undefined,
    };
  }

  // 3. Pick the seed. Default = validator's most-recent-outbound.
  //    Override = caller passed a specific message ID (only the route
  //    handler does this; sync pass passes undefined).
  let seed: ThreadMessageBrief | null = outcome.seed;
  if (args.overrideSeedMessageId) {
    const override = outcome.threadMessages.find(
      (m) => m.id === args.overrideSeedMessageId,
    );
    if (!override) {
      return {
        success: false,
        reason: `seedMessageId ${args.overrideSeedMessageId} not found in thread`,
        validatorResults: outcome.results,
        prospect: outcome.prospect ?? undefined,
      };
    }
    if (override.direction !== "outbound") {
      return {
        success: false,
        reason: "seedMessageId must reference an outbound (sent-by-user) message",
        validatorResults: outcome.results,
        prospect: outcome.prospect ?? undefined,
      };
    }
    seed = override;
  }
  if (!seed) {
    return {
      success: false,
      reason: "internal: validator returned ok with null seed",
    };
  }
  if (!outcome.prospect) {
    return {
      success: false,
      reason: "internal: validator returned ok with null prospect",
    };
  }

  // 4. Compute F1 schedule. max(sentAt + 7d, markedAt + 1d).
  const markedAt = new Date();
  const scheduledAt = computeFirstFollowupAt({
    sentAt: seed.sentAt,
    markedAt,
  });

  // 5. Insert prospect. originalLanguage uses the schema default ("en");
  //    B9c's generator detect-and-fills at generation time if needed.
  //    vertical / product use schema defaults — re-engagement doesn't
  //    carry the original outreach's vertical forward.
  const inserted = await db
    .insert(prospectsTable)
    .values({
      userId: args.userId,
      prospectName: outcome.prospect.name || outcome.prospect.email,
      email: outcome.prospect.email,
      company: outcome.prospect.email.split("@")[1] ?? "",
      sentAt: seed.sentAt,
      subject: seed.subject,
      originalBody: seed.body,
      gmailMessageId: seed.id,
      gmailThreadId: args.gmailThreadId,
      app: "anti_ghosting",
      cycle: 1,
    })
    .returning({ id: prospectsTable.id });

  if (inserted.length === 0) {
    return {
      success: false,
      reason: "prospect insert returned empty result",
    };
  }
  const prospectId = inserted[0].id;

  // 6. Sync the thread into thread_messages. Best-effort — failure here
  //    leaves the prospect created with F1 still scheduled; a future
  //    per-cycle re-read backfills the messages.
  try {
    await syncThreadFromGmail(prospectId, args.gmail, args.userEmail);
  } catch (err) {
    logger.warn(
      { err, prospectId, gmailThreadId: args.gmailThreadId },
      "syncThreadFromGmail failed during ingest; prospect is created, thread_messages may be incomplete",
    );
  }

  // 7. Schedule F1. status="queued" per B9c.1 scheduler contract.
  await db.insert(followupsTable).values({
    prospectId,
    stage: 1,
    cycle: 1,
    status: "queued",
    scheduledAt,
  });

  logger.info(
    {
      prospectId,
      userId: args.userId,
      gmailThreadId: args.gmailThreadId,
      scheduledAt: scheduledAt.toISOString(),
    },
    "AntiGhosting prospect ingested",
  );

  return {
    success: true,
    prospectId,
    scheduledAt,
    validatorResults: outcome.results,
    prospect: outcome.prospect,
    seed: {
      gmailMessageId: seed.id,
      subject: seed.subject,
      sentAt: seed.sentAt,
    },
  };
}

/**
 * Sync-pass orchestrator. Lists threads with the user's AntiGhosting
 * label, filters out the already-marked ones, and ingests each via
 * ingestAntiGhostingThread. Designed to be called from gmailSync's
 * per-user pass.
 *
 * Counts:
 *   ingested:  newly-created anti_ghosting prospects
 *   skipped:   threads already-marked or with no thread.id
 *   failed:    validator rejections + unexpected errors (both
 *              non-fatal; the loop continues)
 *
 * Returns zero across the board (and logs nothing) when the user
 * doesn't have the AntiGhosting label set or it doesn't match anything
 * in their mailbox — typical state for users who haven't started using
 * the product yet.
 *
 * The Gmail threads.list call is capped at 50 results per sync cycle.
 * If a user labels more than 50 threads at once, the surplus picks up
 * on subsequent cycles. Acceptable for the operator-driven labeling
 * pattern (no one labels 100+ threads in a single sitting).
 */
export async function ingestAntiGhostingLabeledThreads(args: {
  userId: number;
  gmail: gmail_v1.Gmail;
  userEmail: string;
  antiGhostingLabel: string;
}): Promise<{ ingested: number; skipped: number; failed: number }> {
  if (!args.antiGhostingLabel || args.antiGhostingLabel.trim() === "") {
    return { ingested: 0, skipped: 0, failed: 0 };
  }

  const labelIds = await resolveAntiGhostingLabelIds(
    args.gmail,
    args.antiGhostingLabel,
  );
  if (labelIds.length === 0) {
    return { ingested: 0, skipped: 0, failed: 0 };
  }

  // 2026-07-29: per-label union (OR), not a single AND'd labelIds call —
  // see listThreadsWithAnyLabel. alreadyMarked is resolved FIRST and passed
  // as the skip set so already-ingested threads don't consume the cap.
  const alreadyMarked = await getAlreadyMarkedThreadIds(args.userId);
  const threads = await listThreadsWithAnyLabel(args.gmail, labelIds, 50, {
    skipThreadIds: alreadyMarked,
  });
  if (threads.length === 0) {
    return { ingested: 0, skipped: 0, failed: 0 };
  }

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (const t of threads) {
    if (!t.id) {
      skipped++;
      continue;
    }
    if (alreadyMarked.has(t.id)) {
      skipped++;
      continue;
    }

    try {
      const result = await ingestAntiGhostingThread({
        userId: args.userId,
        gmail: args.gmail,
        userEmail: args.userEmail,
        gmailThreadId: t.id,
      });
      if (result.success) {
        ingested++;
      } else if (result.alreadyMarked) {
        skipped++;
      } else {
        // Validator rejection — log at debug because this is expected
        // behaviour for threads that aren't valid AntiGhosting
        // candidates (most-recent inbound, no inbound at all, etc.).
        failed++;
        logger.debug(
          { threadId: t.id, reason: result.reason, userId: args.userId },
          "AntiGhosting auto-ingest skipped — validator rejected thread",
        );
      }
    } catch (err) {
      // Unexpected error — log at warn so it surfaces in monitoring.
      failed++;
      logger.warn(
        { err, threadId: t.id, userId: args.userId },
        "AntiGhosting auto-ingest threw",
      );
    }
  }

  if (ingested > 0 || failed > 0) {
    logger.info(
      { userId: args.userId, ingested, skipped, failed, totalThreads: threads.length },
      "AntiGhosting auto-ingest pass complete",
    );
  }
  return { ingested, skipped, failed };
}
