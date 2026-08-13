import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { eq, ne, and, lte, lt, inArray, or, isNull, isNotNull, sql } from "drizzle-orm";
import { generateFollowupEmail } from "./followupGenerator";
import type { GeneratedFollowup } from "./followupGenerator";
// CSD v1: company-shared drafts. One LLM pipeline run per company cohort
// (same user, app, company, ORIGINAL THREAD LANGUAGE, stage, cycle, campaign
// context, history) instead of one per contact. All cache functions are
// fail-open: any error degrades to the pre-CSD per-contact generation path.
import {
  buildCohortDescriptor,
  buildAlignmentKey,
  pickCohortAnchors,
  lookupSharedDraft,
  storeSharedDraft,
  recordSharedDraftReuse,
  countActiveCohortMembers,
  detectPersonalNameLeak,
} from "./companyDraftCache";
// B9c.2: AntiGhosting generator wiring + thread re-read helper.
import { generateAntiGhostingFollowup } from "./antiGhostingFollowupGenerator";
import { computeDaysSinceSeedTier } from "./antiGhostingFollowupPrompts";
import type { AntiGhostingFollowupContext } from "./antiGhostingFollowupPrompts";
import { parseGmailThread } from "./antiGhostingValidators";
import {
  createFollowupDraft,
  deleteDraft,
  getGmailForUser,
  sendFollowupReply,
} from "./gmailClient";
import type { FollowupContext, PreviousFollowup } from "./followupPrompts";
import { logger } from "../lib/logger";
import { computeNextStageScheduledAt } from "./timingEngine";
import type { FollowupScheduleMode, UserTimingSettings } from "./timingEngine";

import { isInSendWindow } from "../lib/scheduleWindow";
import { checkSendBudget } from "../lib/sendBudget";
// 2026-07-23 deliverability incident: send-time spam gate. Scores the FINAL
// subject+body right before auto-send; high-risk emails are diverted to
// pending_approval (human decision) instead of shipping to a spam folder.
import { assessSpamRisk, spamGateEnabled, spamGateMode } from "../lib/spamRiskLint";
import { generateContextFollowup } from "./contextFollowupGenerator";
// B7r: usage context import. Wraps generator calls so the recordUsage
// helper inside the generators knows which followup the LLM call is for.
import { runWithUsageContext } from "../lib/usageContext";
// F-3.7b: per-row generation wall-clock budget. See lib/generationDeadline.ts
// for why 180s and what it does and does not bound.
import { withGenerationDeadline } from "../lib/generationDeadline";
// Global pause switch: when on, bulk cron processing and bulk auto-queue stop.
import { isGlobalPauseEnabled } from "../lib/globalPause";
// F-3.6a: bounded retry policy replacing the amnesia revive, the due-batch
// rules, and the stranded classifier. All three are pure and db-free.
import {
  decideFailedRowAction,
  classifyProcessingFailure,
  appendFailure,
  makeFailureRecord,
  MAX_AUTO_RETRIES,
  type HoldReason,
} from "../lib/retryPolicy";
import { DUE_BATCH_LIMIT } from "../lib/dueEligibility";
import {
  GENERATING_STRAND_HOURS,
  strandedCutoff,
  strandedErrorMessage,
} from "../lib/strandedGenerating";
import { isAuthError, classifyAuthReason } from "../lib/connectionHealth";
// F-3.6b: the send identity, and the cycle-scoped stage rules. Both pure.
import { resolveSendIdentity, OWNER_MISSING_MESSAGE } from "../lib/ownerIdentity";
import { campaignPosition, type StageRow } from "../lib/cycleScope";
import type { FailureReason } from "@workspace/db";
import { getDailyBudgetState } from "../lib/dailyBudget";
// Global address suppression: never send to a suppressed address.
import { isSuppressed } from "../lib/suppression";
// CB-2 / CB-3: rigid follow-up cap + 30-day campaign max-age.
import { effectiveFollowupCap, CAMPAIGN_MAX_AGE_DAYS, HARD_FOLLOWUP_CAP } from "../lib/followupLimits";

const ACTIVE_FOLLOWUP_STATUSES = ["queued", "generating", "pending_approval", "drafted"];
const STALLED_AWAITING_MANUAL_SEND = "stalled_awaiting_manual_send";
const DRAFT_STALL_DAYS = 30;

function getFollowupCap(maxFollowups?: number | null): number {
  // CB-2: the cap is now rigid. effectiveFollowupCap clamps any stored value
  // into 1..HARD_FOLLOWUP_CAP and resolves the legacy 0 ("unlimited") to the
  // hard cap, so no path can schedule more than HARD_FOLLOWUP_CAP stages.
  return effectiveFollowupCap(maxFollowups);
}

function buildUserTimingSettings(user: typeof usersTable.$inferSelect): UserTimingSettings {
  return {
    stageTiming: user.stageTiming,
    draftStageTiming: user.draftStageTiming,
    sendDays: user.sendDays,
    sendHourStart: user.sendHourStart,
    sendHourEnd: user.sendHourEnd,
  };
}

function getScheduleMode(user?: typeof usersTable.$inferSelect | null): FollowupScheduleMode {
  return user?.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send";
}

function isActiveFollowupStatus(status: string): boolean {
  return ACTIVE_FOLLOWUP_STATUSES.includes(status);
}

/**
 * F-3.6b: everything queueing one stage needs to know about the prospect, in
 * one round-trip.
 *
 * This replaces F-3.6a's `isProspectOwnerAuthDead()`, which answered one of
 * these three questions and has no remaining callers. Delete, do not wrap.
 *
 * `cycle` is the addition, and it is the whole point. B9a made the unique key
 * `(prospect_id, cycle, stage)` but left the queueing path reading and writing
 * `(prospect_id, stage)`, so a renewed AntiGhosting campaign collided with its
 * own previous cycle. See lib/cycleScope.ts.
 *
 * LEFT JOIN, not INNER: the previous version of this lookup used an inner
 * join, so a prospect with `user_id = NULL` produced no row and answered
 * "owner not auth-dead" — true, but only because it had no owner at all. That
 * distinction now matters, so it is carried explicitly.
 */
async function loadProspectQueueContext(prospectId: number): Promise<{
  cycle: number;
  ownerMissing: boolean;
  ownerAuthDead: boolean;
} | null> {
  const row = (await db
    .select({
      cycle: prospectsTable.cycle,
      userId: prospectsTable.userId,
      authDeadAt: usersTable.authDeadAt,
    })
    .from(prospectsTable)
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
    .where(eq(prospectsTable.id, prospectId))
    .limit(1))[0];
  if (!row) return null;
  return {
    cycle: row.cycle ?? 1,
    ownerMissing: row.userId === null || row.userId === undefined,
    ownerAuthDead: Boolean(row.authDeadAt),
  };
}

/**
 * F-3.6a: mark an account auth-dead from the send path.
 *
 * The `auth_dead_at IS NULL` guard is the state machine's "dead + failure →
 * no write" rule expressed as SQL: the FIRST failure's timestamp is the one
 * the operator needs ("dead since 2026-07-31" is actionable; "dead since four
 * minutes ago" is not), repeat calls are no-ops, and two concurrent workers
 * discovering the same dead grant cannot race each other into a later date.
 *
 * Clearing is deliberately NOT done here. Only a positive proof of health —
 * a completed sync ingest, or the deploy-time probe — may clear the state,
 * and neither of those happens on this code path.
 */
async function markUserAuthDead(userId: number, rawError: string): Promise<void> {
  const now = new Date();
  const result = await db
    .update(usersTable)
    .set({
      authDeadAt: now,
      authDeadReason: classifyAuthReason(rawError),
      updatedAt: now,
    })
    .where(and(eq(usersTable.id, userId), isNull(usersTable.authDeadAt)));

  if (result.rowCount) {
    logger.error(
      { userId, reason: classifyAuthReason(rawError) },
      "F-3.6a: Gmail grant marked AUTH-DEAD from the send path — this account stops queueing and generating until it reconnects",
    );
  }
}

export async function processDueFollowups(options?: {
  followupId?: number;
  forceSend?: boolean;
  /**
   * F-3.7b: called once per row, however the row ended — sent, drafted,
   * skipped or failed. The cron overlap guard uses it as the pass's own
   * heartbeat: a pass still finishing rows is alive, and a pass that has
   * called this for PROCESS_WEDGE_NO_PROGRESS_MS is wedged on one row and
   * gets broken. Never throws into the loop; see the per-row finally.
   */
  onProgress?: () => void;
}): Promise<{
  processed: number;
  sent: number;
  drafted: number;
  failed: number;
}> {
  // Global pause halts the bulk cron path. An explicit single-item send
  // (forceSend with a followupId) is still allowed so an operator can push
  // one message through while everything else is paused.
  if (!options?.followupId && (await isGlobalPauseEnabled())) {
    logger.info("Global pause active — skipping bulk follow-up processing");
    return { processed: 0, sent: 0, drafted: 0, failed: 0 };
  }

  // >>> DAILY_BUDGET_CAP (managed by ship bundle; do not edit between sentinels)
  // Global daily budget cap. When tool-wide spend for the current budget day
  // (local midnight, Asia/Jerusalem) has reached the cap, generation stops for
  // every path: the autonomous cron pipeline and explicit Send-Now alike. Every
  // due follow-up, including the later stages of every campaign and list, stays
  // 'queued' and resumes after the next reset. Reply handling is never gated
  // here; only generation, the deferrable cost driver, is held back. This is
  // intentionally stricter than global-pause, which a single Send-Now bypasses.
  {
    const budget = await getDailyBudgetState();
    if (budget.enabled && budget.exceeded) {
      logger.warn(
        {
          spentUsd: budget.spentUsd,
          capUsd: budget.capUsd,
          windowStart: budget.windowStartUtc.toISOString(),
          timeZone: budget.timeZone,
          forceSend: !!options?.forceSend,
        },
        "Daily budget cap reached - deferring all follow-up generation to the next budget day",
      );
      return { processed: 0, sent: 0, drafted: 0, failed: 0 };
    }
  }
  // <<< DAILY_BUDGET_CAP

  const conditions = [
    eq(followupsTable.status, "queued"),
    lte(followupsTable.scheduledAt, new Date()),
  ];
  if (!options?.forceSend) {
    // B9b.12.5: AG prospects bypass the replied gate so manually-resumed
    // replied threads can be processed by the cron. Doctrine/Context keep
    // strict replied=0 filtering. Pause stays universal.
    conditions.push(or(eq(prospectsTable.replied, 0), eq(prospectsTable.app, "anti_ghosting"))!);
    conditions.push(eq(prospectsTable.followupPaused, false));

    // ── F-3.6a: held users are excluded HERE, at SELECT time. ───────────
    //
    // Admin-paused rows used to pass this query and get skipped inside the
    // loop by a `continue`. On 2026-08-09 the fifteen oldest eligible rows
    // in the entire system all belonged to one admin-paused account, so
    // every tick selected them, skipped them, and did 5 rows of real work
    // out of 20 — for ever, with everything behind them starved (F-D4).
    // Auth-dead accounts were about to be worse: their rows were not
    // skipped at all, they were generated at full cost and then failed.
    //
    // LEFT JOIN, not INNER: prospects.user_id is nullable for legacy rows
    // that predate multi-user, and an inner join would have silently
    // stopped processing every one of them. `user_id IS NULL` keeps them.
    //
    // A row whose user_id points at a missing user resolves to NULL on both
    // comparisons and is therefore excluded — which is strictly better than
    // before, where it was selected and then dropped by the in-loop
    // "Gmail credentials unavailable" guard after occupying a slot.
    //
    // Ordering and the batch size are deliberately unchanged.
    conditions.push(
      or(
        isNull(prospectsTable.userId),
        and(eq(usersTable.pausedByAdmin, false), isNull(usersTable.authDeadAt)),
      )!,
    );
  }
  if (options?.followupId) {
    conditions.push(eq(followupsTable.id, options.followupId));
  }

  const due = await db
    .select({
      followupId: followupsTable.id,
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
      vertical: prospectsTable.vertical,
      subVertical: prospectsTable.subVertical,
      product: prospectsTable.product,
      originalSubject: prospectsTable.subject,
      originalBodySummary: prospectsTable.originalBodySummary,
      originalBody: prospectsTable.originalBody,
      originalLanguage: prospectsTable.originalLanguage,
      // CSD v1: batchLabel feeds the cohort batch key.
      batchLabel: prospectsTable.batchLabel,
      gmailThreadId: prospectsTable.gmailThreadId,
      gmailMessageId: prospectsTable.gmailMessageId,
      sentAt: prospectsTable.sentAt,
      userId: prospectsTable.userId,
      // Phase 7b: discriminator for which generator to use per row.
      app: prospectsTable.app,
      // B9c.2: cycle is needed both for AntiGhosting context build
      // and for cycle-scoped previousFollowups query.
      cycle: followupsTable.cycle,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    // F-3.6a: LEFT so legacy rows with a null user_id survive. See the
    // held-user condition above.
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
    .where(and(...conditions))
    .orderBy(followupsTable.scheduledAt)
    .limit(DUE_BATCH_LIMIT);

  if (due.length === 0) {
    return { processed: 0, sent: 0, drafted: 0, failed: 0 };
  }

  logger.info({ count: due.length }, "Processing due follow-ups");

  const userCache = new Map<number, typeof usersTable.$inferSelect>();

  let sent = 0;
  let drafted = 0;
  let failed = 0;

  for (const item of due) {
    // F-3.6a: set the moment something lands in the user's Gmail — a sent
    // message or a created draft — and read by the catch below.
    //
    // Between the Gmail call succeeding and the status write landing there is
    // a window in which the email EXISTS but the row still says `queued`. If
    // the write throws in that window the row becomes `failed` with no trace
    // that delivery happened, and retrying it puts a second copy in the
    // client's inbox. Before F-3.6a such a row was revived every 15 minutes,
    // unbounded. Recording the artifact id here lets the catch classify the
    // failure `stranded` — which the retry policy treats as terminal — so the
    // duplicate can never be sent automatically.
    let gmailArtifactId: string | null = null;

    try {
      // ── F-3.6b: the identity comes from the OWNER or nowhere. ───────────
      //
      // This block used to open by seeding senderEmail/senderName from
      // `process.env.SENDER_EMAIL` / `SENDER_NAME`, and `sendFollowupReply`
      // fell back to `GOOGLE_REFRESH_TOKEN`. A prospect with `user_id = NULL`
      // never entered the owner branch, kept all three, and was delivered
      // from the shared fallback mailbox — a client's follow-up going out
      // under an identity unrelated to the campaign that owns it. Both
      // variables are set in this deployment, so this was live.
      //
      // There is no identity of last resort now. `resolveSendIdentity` is a
      // pure function with no `process.env` in it at all.
      if (item.userId) {
        if (!userCache.has(item.userId)) {
          const users = await db.select().from(usersTable).where(eq(usersTable.id, item.userId)).limit(1);
          if (users.length > 0) userCache.set(item.userId, users[0]);
        }
      }
      const identity = resolveSendIdentity({
        userId: item.userId,
        owner: item.userId ? userCache.get(item.userId) : null,
      });

      // An ownerless row does not "skip" — skipping is what kept it invisible
      // and re-selected on every tick. It fails, with the reason on the row,
      // countable on the admin surface, and it reaches no Gmail call of any
      // kind: nothing is generated, nothing is claimed, nothing is sent.
      if (!identity.ok && identity.reason === "owner_missing") {
        logger.error(
          { followupId: item.followupId, prospectId: item.prospectId },
          "F-3.6b: prospect has no owning account — REFUSING to send. Before this order the row " +
            "would have gone out from the shared fallback mailbox.",
        );
        await db
          .update(followupsTable)
          .set({
            status: "failed",
            errorMessage: OWNER_MISSING_MESSAGE,
            failureReason: "owner_missing",
          })
          .where(and(eq(followupsTable.id, item.followupId), eq(followupsTable.status, "queued")));
        failed++;
        continue;
      }

      // B7u: skip paused users in process. Don't generate, don't send.
      // Existing queued rows stay queued until the user is resumed.
      if (item.userId) {
        const cached = userCache.get(item.userId);
        if (cached && cached.pausedByAdmin) {
          logger.info(
            { followupId: item.followupId, prospectId: item.prospectId, userId: item.userId },
            "B7u: user paused by admin — skipping follow-up",
          );
          continue;
        }
        // F-3.6a: defence in depth. The batch query already excludes
        // auth-dead accounts, but forceSend bypasses that query's user
        // conditions entirely, and a grant can die between the SELECT and
        // this row's turn. Either way, generating here would cost a full
        // LLM pipeline to produce something Google will refuse to send.
        if (cached && cached.authDeadAt) {
          logger.warn(
            {
              followupId: item.followupId,
              prospectId: item.prospectId,
              userId: item.userId,
              deadSince: cached.authDeadAt.toISOString(),
            },
            "F-3.6a: account is auth-dead — skipping follow-up (no generation, no send) until it reconnects",
          );
          continue;
        }
      }
      // The owner exists but holds no usable grant (never connected, or
      // disconnected). Unchanged from before F-3.6b: the row stays queued and
      // waits for the account to connect. This is a waiting state, not a
      // defect — which is exactly why it is a DIFFERENT refusal from
      // `owner_missing` above, where waiting fixes nothing.
      if (!identity.ok) {
        logger.warn(
          { followupId: item.followupId, prospectId: item.prospectId, userId: item.userId },
          "User Gmail credentials unavailable — skipping follow-up",
        );
        continue;
      }

      const { senderEmail, senderName } = identity;
      const gmail = getGmailForUser({ refreshToken: identity.refreshToken, email: senderEmail });

      // Suppression gate: never send to a globally suppressed address. A hard
      // bounce earlier put the recipient on the list. Cancel the follow-up
      // and pause the campaign as bounced so it leaves the active pipeline,
      // rather than deferring (the address will not recover). forceSend does
      // NOT bypass this — an explicit send to a dead address is still wrong.
      if (item.email && (await isSuppressed(item.email))) {
        await db
          .update(followupsTable)
          .set({ status: "cancelled", errorMessage: "Recipient address is suppressed (prior hard bounce)." })
          .where(and(eq(followupsTable.id, item.followupId), inArray(followupsTable.status, ["queued", "generating"])));
        await db
          .update(prospectsTable)
          .set({ followupPaused: true, pauseReason: "bounced", bounceType: "hard", pausedAt: new Date() })
          .where(and(eq(prospectsTable.id, item.prospectId), or(ne(prospectsTable.pauseReason, "bounced"), isNull(prospectsTable.pauseReason))));
        logger.info(
          { followupId: item.followupId, prospectId: item.prospectId },
          "Recipient suppressed — follow-up cancelled, campaign paused",
        );
        continue;
      }

      // Phase 6 gate A: send-window enforcement at SEND time.
      // forceSend bypasses the window — explicit user actions are trusted.
      // Cron-driven sends defer the row (status stays 'queued') if outside.
      if (!options?.forceSend && item.userId) {
        const userForWindow = userCache.get(item.userId);
        if (userForWindow) {
          const win = isInSendWindow(userForWindow, new Date());
          if (!win.ok) {
            logger.info(
              { followupId: item.followupId, prospectId: item.prospectId, reason: win.reason, utcDay: win.utcDay, utcHour: win.utcHour },
              "Outside send window — deferring follow-up to next tick",
            );
            continue;
          }
        }
      }

      // Phase 6 gate B: per-user send rate limiter.
      // forceSend bypasses the cap (Send Now is an explicit user choice).
      // Bulk Send-Now is separately capped to 25 at the route level.
      if (!options?.forceSend && item.userId) {
        const budget = await checkSendBudget({ userId: item.userId });
        if (!budget.allowed) {
          logger.warn(
            {
              followupId: item.followupId,
              prospectId: item.prospectId,
              userId: item.userId,
              reason: budget.reason,
              sentLastHour: budget.sentLastHour,
              hourlyCap: budget.hourlyCap,
              sentToday: budget.sentToday,
              dailyCap: budget.dailyCap,
            },
            "Send budget exceeded — deferring follow-up to next tick",
          );
          continue;
        }
      }

      const claimResult = await db
        .update(followupsTable)
        .set({ status: "generating" })
        .where(and(eq(followupsTable.id, item.followupId), eq(followupsTable.status, "queued")));
      if (!claimResult.rowCount || claimResult.rowCount === 0) {
        logger.warn({ followupId: item.followupId }, "Follow-up already claimed by another worker — skipping");
        continue;
      }

      const sentDate = new Date(item.sentAt);
      const now = new Date();
      const daysSince = Math.floor(
        (now.getTime() - sentDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      const previousFollowups: PreviousFollowup[] = [];
      if (item.stage > 1) {
        const pastFollowups = await db
          .select({
            stage: followupsTable.stage,
            generatedSubject: followupsTable.generatedSubject,
            generatedBody: followupsTable.generatedBody,
          })
          .from(followupsTable)
          .where(
            and(
              eq(followupsTable.prospectId, item.prospectId),
              eq(followupsTable.status, "sent"),
              lt(followupsTable.stage, item.stage),
              // B9c.2: cycle scoping — AntiGhosting renewals re-use
              // stage numbers across cycles, so prior-stage queries
              // MUST filter by the same cycle. Doctrine/context have
              // cycle=1 default so this is a no-op for them.
              eq(followupsTable.cycle, item.cycle),
            ),
          )
          .orderBy(followupsTable.stage);

        for (const pf of pastFollowups) {
          if (pf.generatedBody && pf.generatedSubject) {
            previousFollowups.push({
              stage: pf.stage,
              subject: pf.generatedSubject,
              body: pf.generatedBody,
            });
          }
        }
      }

      // B9c.2: when the row is for an anti_ghosting prospect, build
      // a separate AntiGhostingFollowupContext via a LIVE re-read of
      // the Gmail thread. We do this BEFORE building the existing ctx
      // so both are ready at dispatch time. Failures here (user not
      // connected, Gmail API error) throw and let the outer per-row
      // catch log + move on; the row stays "queued" and will retry on
      // the next scheduler tick.
      let antiGhostingCtx: AntiGhostingFollowupContext | null = null;
      if (item.app === "anti_ghosting") {
        if (!item.userId) {
          throw new Error(`anti_ghosting prospect ${item.prospectId} has no userId`);
        }
        if (!userCache.has(item.userId)) {
          const us = await db.select().from(usersTable).where(eq(usersTable.id, item.userId)).limit(1);
          if (us.length > 0) userCache.set(item.userId, us[0]);
        }
        const agUser = userCache.get(item.userId);
        if (!agUser || !agUser.googleRefreshToken || !agUser.isConnected) {
          throw new Error(`anti_ghosting prospect ${item.prospectId}: user ${item.userId} not Gmail-connected`);
        }
        const agGmail = getGmailForUser({
          refreshToken: agUser.googleRefreshToken,
          email: agUser.email,
          name: agUser.name ?? undefined,
        });
        const parsedThread = await parseGmailThread(agGmail, item.gmailThreadId, agUser.email);
        antiGhostingCtx = {
          prospect_name: item.prospectName,
          prospect_email: item.email,
          company: item.company,
          sender_name: senderName,
          seed_subject: item.originalSubject,
          seed_body: item.originalBody,
          thread_messages: parsedThread.map((m) => ({
            direction: m.direction,
            sentAt: m.sentAt,
            fromName: m.fromName,
            fromEmail: m.fromEmail,
            subject: m.subject,
            body: m.body,
          })),
          stage: item.stage,
          cycle: item.cycle,
          days_since_seed: daysSince,
          days_since_seed_tier: computeDaysSinceSeedTier(item.sentAt, new Date()),
          original_language: item.originalLanguage || "en",
          previous_followups: previousFollowups.length > 0
            ? previousFollowups.map((p) => ({ stage: p.stage, subject: p.subject, body: p.body }))
            : undefined,
        };
      }

      const ctx: FollowupContext = {
        prospect_name: item.prospectName,
        company: item.company,
        vertical: item.vertical,
        sub_vertical: item.subVertical || null,
        product: item.product,
        original_subject: item.originalSubject,
        original_body_summary: item.originalBodySummary,
        original_body: item.originalBody,
        original_language: item.originalLanguage || "en",
        stage: item.stage,
        days_since_original: daysSince,
        sender_name: senderName,
        previous_followups: previousFollowups.length > 0 ? previousFollowups : undefined,
      };

      const user = item.userId ? userCache.get(item.userId) : undefined;
      const followupMode = options?.forceSend ? "auto_send" : (user?.followupMode || "auto_send");
      const needsApproval = followupMode === "review_in_app";
      const shouldCreateDraft = followupMode === "draft_in_gmail";

      logger.info(
        {
          stage: item.stage,
          prospect: item.prospectName,
          company: item.company,
          userId: item.userId,
          followupMode,
        },
        "Generating follow-up",
      );
      // CSD v1: company-shared draft dispatch.
      //
      // buildCohortDescriptor returns null for anti_ghosting and context
      // rows and for empty-company rows — those keep the exact pre-CSD
      // behavior. For an eligible doctrine row:
      //   1. Cache HIT (same user/company/LANGUAGE/stage/cycle/context/
      //      history, within TTL): adopt the shared subject+body, make ZERO
      //      LLM calls.
      //   2. Cache MISS with >= 2 active cohort members: generate ONCE in
      //      shared mode — prospect_name is blanked, which triggers the
      //      prompts' existing neutral-greeting branch ("Hi there," /
      //      language-appropriate equivalent) so contact A's name can never
      //      land in contact B's inbox — then store for the siblings.
      //   3. Cache MISS singleton: today's fully personalized generation,
      //      byte-for-byte unchanged, nothing cached.
      // Language isolation is structural: language is a key column, so an
      // English-thread contact can never be served a Spanish shared draft.
      const cohort = buildCohortDescriptor({
        userId: item.userId,
        app: item.app,
        company: item.company,
        originalLanguage: item.originalLanguage || "en",
        stage: item.stage,
        cycle: item.cycle,
        vertical: item.vertical,
        subVertical: item.subVertical || null,
        product: item.product,
        originalSubject: item.originalSubject,
        batchLabel: item.batchLabel || "",
        sentAt: new Date(item.sentAt),
        previousFollowups,
      });
      const sharedHit = cohort ? await lookupSharedDraft(cohort) : null;

      let generated: GeneratedFollowup;
      if (cohort && sharedHit) {
        generated = { subject: sharedHit.subject, body: sharedHit.body };
        await recordSharedDraftReuse(sharedHit.id);
        logger.info(
          {
            followupId: item.followupId,
            prospectId: item.prospectId,
            sharedDraftId: sharedHit.id,
            company: item.company,
            language: cohort.language,
            stage: item.stage,
          },
          "CSD: reused company-shared draft — zero LLM calls for this follow-up",
        );
      } else {
        const sharedMode = cohort ? (await countActiveCohortMembers(cohort)) >= 2 : false;
        // CSD v1.1: shared mode blanks the name AND raises the
        // shared_company_draft flag, which injects an explicit override
        // into the writer, critic, and rewriter prompts: neutral greeting
        // required, no personal name anywhere, even when one is visible in
        // the original email text. Without the flag the critic's nativeness
        // rules pull the source contact's name back into the greeting
        // (production incident 2026-06-08, Bauhaus/de).
        const genCtx: FollowupContext = sharedMode
          ? { ...ctx, prospect_name: "", shared_company_draft: true }
          : ctx;
        if (sharedMode) {
          logger.info(
            { followupId: item.followupId, company: item.company, language: cohort!.language, stage: item.stage },
            "CSD: cohort has 2+ active members — generating shared draft with neutral greeting",
          );
        }
        // Phase 7b: route generation by product. Doctrine flow uses the
        // doctrine prompts + 3-call pipeline. Context flow uses its own
        // prompts (no doctrine, faithful-to-context).
        // B7r: wrap generator dispatch with the usage context so
        // recordUsageBestEffort() inside the generator knows what to attribute.
        // F-3.7b: the row's wall-clock budget. Everything inside — every
        // writer tier, every critic pass, every retry ladder — shares 180s.
        // On expiry this throws GenerationDeadlineError, the catch below
        // classifies it `send_error` (no Gmail artifact exists yet, so
        // nothing can be duplicated), and the pass moves to the next row.
        generated = await withGenerationDeadline(() => runWithUsageContext(
          {
            followupId: item.followupId,
            prospectId: item.prospectId,
            userId: item.userId,
            app: item.app === "anti_ghosting" ? "anti_ghosting"
              : item.app === "context" ? "context" : "doctrine",
            stage: item.stage,
          },
          () => {
            // B9c.2: three-way dispatch. anti_ghosting uses the
            // AntiGhostingFollowupContext built above; doctrine and
            // context share the FollowupContext. (cohort is always null
            // for anti_ghosting/context, so genCtx === ctx there.)
            if (item.app === "anti_ghosting" && antiGhostingCtx) {
              return generateAntiGhostingFollowup(antiGhostingCtx);
            }
            return item.app === "context"
              ? generateContextFollowup(genCtx)
              : generateFollowupEmail(genCtx);
          },
        ));
        if (cohort && sharedMode) {
          // CSD v1.1: deterministic egress guard. If the generated draft
          // contains a name token of the source prospect, it is correct for
          // THIS contact (the name is their own) and still ships to them,
          // but it must never be cached for siblings.
          const leak = detectPersonalNameLeak({
            subject: generated.subject,
            body: generated.body,
            prospectName: item.prospectName,
            company: item.company,
          });
          if (leak.leaked) {
            logger.warn(
              { followupId: item.followupId, company: item.company, language: cohort.language, stage: item.stage, tokens: leak.tokens },
              "CSD: personal name detected in shared draft — sending to this contact only, NOT caching for siblings",
            );
          } else {
            await storeSharedDraft(cohort, generated, {
              prospectId: item.prospectId,
              followupId: item.followupId,
            });
          }
        }
      }

      // 2026-07-23 send-time spam gate (belt-and-suspenders behind the
      // generator-side spamRiskLint): score the FINAL subject+body. This
      // also covers shared-draft cache hits and bodies generated before the
      // linter shipped. A high-risk email is DIVERTED to pending_approval
      // for a human decision — never silently dropped, never auto-failed.
      // review_in_app and draft_in_gmail modes already have a human in the
      // loop, so only the auto-send branch is gated.
      let spamDiverted = false;
      let spamGateReason = "";
      if (spamGateEnabled() && !needsApproval && !shouldCreateDraft) {
        const risk = assessSpamRisk(
          generated.subject,
          generated.body,
          item.originalLanguage || "en",
          [item.originalSubject, item.originalBody, item.originalBodySummary].join("\n"),
        );
        if (risk.highRisk) {
          // forceSend marks a HUMAN-initiated send (approve-in-app re-entry,
          // "Send now" button). Blocking those would make a spam-diverted row
          // unapprovable (approve → re-queue → gate → pending_approval loop),
          // so the gate is advisory there: warn-only, human decision is final.
          if (spamGateMode() === "block" && !options?.forceSend) {
            spamDiverted = true;
            spamGateReason =
              `SPAM-GATE: auto-send blocked (risk score ${risk.score}, rules: ${risk.rules.join(", ")}). ` +
              `Review and approve manually, or edit the draft. ${risk.issues[0] || ""}`.trim();
            logger.warn(
              { followupId: item.followupId, prospect: item.prospectName, score: risk.score, rules: risk.rules },
              "SPAM-GATE: high-risk follow-up diverted to pending_approval instead of auto-sending",
            );
          } else {
            logger.warn(
              { followupId: item.followupId, prospect: item.prospectName, score: risk.score, rules: risk.rules },
              "SPAM-GATE (warn mode): high-risk follow-up will auto-send anyway",
            );
          }
        }
      }

      if (needsApproval || spamDiverted) {
        await db
          .update(followupsTable)
          .set({
            status: "pending_approval",
            generatedBody: generated.body,
            generatedSubject: generated.subject,
            ...(spamDiverted ? { errorMessage: spamGateReason } : {}),
          })
          .where(eq(followupsTable.id, item.followupId));

        logger.info(
          { prospect: item.prospectName, spamDiverted },
          spamDiverted
            ? "Follow-up generated, diverted to approval by spam gate"
            : "Follow-up generated, pending approval",
        );
      } else if (shouldCreateDraft) {
        const draft = await createFollowupDraft({
          followupId: item.followupId,
          threadId: item.gmailThreadId,
          originalMessageId: item.gmailMessageId,
          to: item.email,
          subject: generated.subject,
          body: generated.body,
          senderName,
          senderEmail,
          gmail,
        });
        // F-3.6a: from here on, something exists in the user's Gmail. If the
        // status write below throws, the catch must NOT let this row be
        // retried — see `gmailArtifactId` at the top of the loop body.
        gmailArtifactId = draft.draftId || draft.messageId || "(draft created)";

        await db
          .update(followupsTable)
          .set({
            status: "drafted",
            generatedBody: generated.body,
            generatedSubject: generated.subject,
            draftMessageId: draft.draftId,
            gmailMessageId: draft.messageId || null,
          })
          .where(eq(followupsTable.id, item.followupId));

        drafted++;
        logger.info(
          { prospect: item.prospectName, draftId: draft.draftId, draftMessageId: draft.messageId },
          "Created Gmail follow-up draft",
        );
      } else {
        const gmailMsgId = await sendFollowupReply({
          threadId: item.gmailThreadId,
          originalMessageId: item.gmailMessageId,
          to: item.email,
          subject: generated.subject,
          body: generated.body,
          senderName,
          senderEmail,
          gmail,
        });
        // ── F-3.6a: THE DANGER WINDOW OPENS HERE. ────────────────────────
        // The email is in the client's inbox. Everything below is
        // bookkeeping, and if any of it throws, the row lands in `failed`
        // with no record that delivery happened. Retrying such a row sends
        // a SECOND copy. Recording the id here is what lets the catch
        // classify it `stranded` — terminal, human-resolved — instead of
        // `send_error`. Same reasoning RH-1 applied to the 6-hour case;
        // this is the same window caught in-process.
        gmailArtifactId = gmailMsgId || "(sent, id unavailable)";

        await db
          .update(followupsTable)
          .set({
            status: "sent",
            generatedBody: generated.body,
            generatedSubject: generated.subject,
            sentAt: new Date(),
            gmailMessageId: gmailMsgId,
          })
          .where(eq(followupsTable.id, item.followupId));

        sent++;
        logger.info(
          { prospect: item.prospectName, gmailMsgId },
          "Sent follow-up",
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // F-3.6a: classify the failure so the retry policy can act on it.
      // An auth failure is the owner's dead grant, not this row's fault:
      // retrying it would regenerate at full LLM cost and fail identically.
      // That exact loop produced 196 unsendable follow-ups and 75% of a
      // week's spend before this order (F-D4, 2026-08-09).
      //
      // `stranded` wins over everything: if gmailArtifactId is set, the email
      // or draft already exists in the user's mailbox and only the bookkeeping
      // failed. Such a row must never be retried automatically, whatever the
      // error text says — a retry is a duplicate in a client's inbox.
      const reason: FailureReason = classifyProcessingFailure({
        gmailArtifactId,
        isAuthFailure: isAuthError(err),
      });
      const detail = gmailArtifactId
        ? `${errorMsg} — DELIVERED BUT NOT RECORDED: the Gmail artifact (${gmailArtifactId}) exists. ` +
          `NOT retried automatically. Check the thread: mark sent if it went out, Send-Now if it did not.`
        : errorMsg;

      logger.error(
        {
          err,
          followupId: item.followupId,
          userId: item.userId,
          failureReason: reason,
          gmailArtifactId,
        },
        gmailArtifactId
          ? "Failed follow-up AFTER the Gmail call succeeded — row marked stranded, never auto-retried"
          : "Failed follow-up",
      );

      await db
        .update(followupsTable)
        .set({
          status: "failed",
          errorMessage: detail,
          failureReason: reason,
          // Preserve the id of whatever reached Gmail, so the operator can
          // find it and so a later reader knows delivery happened.
          ...(gmailArtifactId ? { gmailMessageId: gmailArtifactId } : {}),
        })
        .where(eq(followupsTable.id, item.followupId));

      // An auth failure discovered here is authoritative: the send path just
      // asked Google and was refused. Mark the account dead now rather than
      // waiting up to 15 minutes for the next sync tick to find out, so the
      // remaining rows in THIS batch are already held.
      if (reason === "auth_dead" && item.userId) {
        await markUserAuthDead(item.userId, errorMsg).catch((markErr) =>
          logger.error(
            { err: markErr, userId: item.userId },
            "F-3.6a: failed to mark account auth-dead from the send path",
          ),
        );
      }

      failed++;
    } finally {
      // F-3.7b: one row finished, whatever its verdict — including the
      // `continue` paths above, which a finally still covers. This is the
      // only signal the cron wedge watchdog has that the pass is alive, so
      // it must never be able to throw into the loop.
      try {
        options?.onProgress?.();
      } catch (progressErr) {
        logger.error({ err: progressErr }, "F-3.7b: onProgress callback threw — ignored");
      }
    }
  }

  logger.info({ sent, drafted, failed }, "Follow-up processing done");

  return { processed: due.length, sent, drafted, failed };
}

export async function autoQueueNextStages(): Promise<number> {
  // DEPRECATED: test mode was removed. The "Send now" button is the only
  // immediate-send path. All scheduled auto-queueing now goes through
  // autoQueueAllCampaigns() which uses each user's production timing window.
  // This function is retained as a no-op for API/caller compatibility.
  return 0;
}

export async function queueNextFollowupStageForProspect(prospectId: number): Promise<{
  queued: boolean;
  stage: number | null;
  scheduledAt: Date | null;
  reason?: string;
}> {
  const prospect = (await db
    .select()
    .from(prospectsTable)
    .where(eq(prospectsTable.id, prospectId))
    .limit(1))[0];

  if (!prospect) return { queued: false, stage: null, scheduledAt: null, reason: "prospect_not_found" };
  // B9b.12.5: AG prospects bypass the replied gate (manual re-engagement).
  if (prospect.replied && prospect.app !== "anti_ghosting") return { queued: false, stage: null, scheduledAt: null, reason: "prospect_replied" };
  if (prospect.followupPaused) return { queued: false, stage: null, scheduledAt: null, reason: "prospect_paused" };
  if (!prospect.userId) return { queued: false, stage: null, scheduledAt: null, reason: "missing_user" };

  const user = (await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, prospect.userId))
    .limit(1))[0];

  if (!user || !user.isConnected || !user.googleRefreshToken) {
    return { queued: false, stage: null, scheduledAt: null, reason: "user_not_connected" };
  }

  const existingFollowups = await db
    .select({
      id: followupsTable.id,
      cycle: followupsTable.cycle,
      stage: followupsTable.stage,
      status: followupsTable.status,
      sentAt: followupsTable.sentAt,
    })
    .from(followupsTable)
    .where(eq(followupsTable.prospectId, prospectId));

  // F-3.6b: scoped to the prospect's CURRENT cycle. Unscoped, a renewed
  // AntiGhosting campaign inherits the previous cycle's three sent stages: it
  // reports "active follow-up exists" against rows that belong to a finished
  // cycle, and its nextStage starts at 4 and is rejected by the cap.
  const cycle = prospect.cycle ?? 1;
  const position = campaignPosition(existingFollowups, cycle);

  if (position.hasActive) {
    return { queued: false, stage: null, scheduledAt: null, reason: "active_followup_exists" };
  }

  const nextStage = position.nextStage;
  const maxFollowups = getFollowupCap(user.maxFollowups);

  if (nextStage > maxFollowups) {
    return { queued: false, stage: nextStage, scheduledAt: null, reason: "max_followups_reached" };
  }

  const scheduledAt = computeNextStageScheduledAt({
    stage: nextStage,
    initialSentAt: prospect.sentAt,
    lastFollowupSentAt: position.lastSentAt,
    userSettings: buildUserTimingSettings(user),
    mode: getScheduleMode(user),
  });

  // F-3.6a: this path is reached from the reply/manual-resume flows, which
  // are human-initiated, so it overrides the retry policy — but it still
  // refuses an auth-dead account. Queueing a stage against a grant Google
  // refuses buys a generation that cannot be delivered.
  // F-3.6b: `cycle` is already resolved here, so it is passed rather than
  // re-read.
  const { queued: didQueue, held } = await queueStageForProspect(
    prospectId,
    nextStage,
    scheduledAt,
    { ownerAuthDead: Boolean(user.authDeadAt), ownerMissing: false, cycle, automatic: false },
  );

  return {
    queued: didQueue,
    stage: nextStage,
    scheduledAt,
    reason: didQueue ? undefined : (held ?? "insert_conflict"),
  };
}

export async function requeueStalledDraftForProspect(prospectId: number): Promise<{
  requeued: boolean;
  stage: number | null;
}> {
  const stalled = await db
    .select({ id: followupsTable.id, stage: followupsTable.stage })
    .from(followupsTable)
    .where(and(
      eq(followupsTable.prospectId, prospectId),
      eq(followupsTable.status, STALLED_AWAITING_MANUAL_SEND),
    ))
    .orderBy(followupsTable.stage)
    .limit(1);

  if (!stalled[0]) return { requeued: false, stage: null };

  const result = await db
    .update(followupsTable)
    .set({
      status: "queued",
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
      draftMessageId: null,
      errorMessage: null,
    })
    .where(and(
      eq(followupsTable.id, stalled[0].id),
      eq(followupsTable.status, STALLED_AWAITING_MANUAL_SEND),
    ));

  return { requeued: Boolean(result.rowCount), stage: result.rowCount ? stalled[0].stage : null };
}

export interface QueueStageOptions {
  /**
   * True when Google refuses this prospect's owner's grant. Nothing is queued
   * while it is true; the rows wait, nothing is cancelled, and they resume
   * the moment the account reconnects.
   *
   * OMIT IT and this function looks it up. That is the safe default and the
   * right one for every human-triggered route — they hold a prospect id, not
   * a user record, and an auth-dead account must be refused wherever the
   * request came from. Pass `false` explicitly only where the caller has
   * already excluded auth-dead users (the auto-queue sweep), so the hot loop
   * costs no extra query.
   */
  ownerAuthDead?: boolean;
  /**
   * F-3.6b. The prospect's current cycle — `prospects.cycle`.
   *
   * OMIT IT and this function looks it up, like `ownerAuthDead`. It is not
   * optional to the DECISION: the unique key has been
   * `(prospect_id, cycle, stage)` since B9a, so a lookup or an insert that
   * ignores the cycle addresses the wrong row. See lib/cycleScope.ts.
   */
  cycle?: number;
  /**
   * F-3.6b. True when the prospect has no owning account at all.
   *
   * Held, not queued: there is no identity to send as, so a queued stage
   * would be generated and then refused by the send path. Looked up when
   * omitted. Clears by itself the moment an owner is assigned.
   */
  ownerMissing?: boolean;
  /**
   * True for the 15-minute auto-queue sweep. False for an explicit human
   * action — the dashboard queue buttons, admin salvage, a manual resume.
   *
   * Only AUTOMATIC revival obeys the retry policy. A human who presses the
   * button has decided, and gets the same override Send-Now has over the
   * send budget. Evidence is preserved either way: the override is about
   * whether the row moves, never about whether the history survives.
   */
  automatic: boolean;
}

/**
 * Queue (or revive) one stage for one prospect.
 *
 * F-3.6a changed the revival half of this function. It used to blank a
 * previously-failed row on the way through — status, errorMessage,
 * generatedBody, generatedSubject, all nulled — which is why the whole fleet
 * showed two failed rows on 2026-08-09 while six accounts were failing every
 * send they attempted. Now:
 *
 *   cancelled/other → revived exactly as before, cleared. A cancel IS a
 *                     clean slate; there is no failure evidence to keep.
 *   failed          → the retry policy decides (retryPolicy.ts), and a row
 *                     that is revived keeps every field it had. Only status,
 *                     scheduledAt, retryCount and errorHistory move.
 */
export async function queueStageForProspect(
  prospectId: number,
  stage: number,
  scheduledAt: Date,
  options: QueueStageOptions,
): Promise<{ queued: boolean; revived: boolean; held?: HoldReason }> {
  // F-3.6b: resolve cycle / owner state in ONE round-trip, and only when the
  // caller has not already supplied every piece. `cycle` is not optional to
  // the decision — see QueueStageOptions.
  const needsLookup =
    options.cycle === undefined ||
    options.ownerAuthDead === undefined ||
    options.ownerMissing === undefined;
  const ctx = needsLookup ? await loadProspectQueueContext(prospectId) : null;
  if (needsLookup && !ctx) {
    // No such prospect. Previously this fell through to an INSERT that died
    // on the foreign key; refusing is the same outcome without the exception.
    logger.warn({ prospectId, stage }, "F-3.6b: not queueing — prospect does not exist");
    return { queued: false, revived: false };
  }
  const cycle = options.cycle ?? ctx!.cycle;
  const ownerAuthDead = options.ownerAuthDead ?? ctx!.ownerAuthDead;
  const ownerMissing = options.ownerMissing ?? ctx!.ownerMissing;

  // F-3.6a: an auth-dead owner blocks the WHOLE function — fresh inserts as
  // well as revivals. Google refuses the grant, so any stage queued here is a
  // full-cost generation with no possible delivery. This one is not human-
  // overridable: pressing the button harder does not make a dead token work,
  // and a reconnect clears the state (and therefore this guard) instantly.
  if (ownerAuthDead) {
    logger.info(
      { prospectId, stage, automatic: options.automatic },
      "F-3.6a: not queueing — the owning account's Gmail grant is auth-dead. Queueing resumes automatically on reconnect.",
    );
    return { queued: false, revived: false, held: "auth_dead" };
  }

  // F-3.6b: same shape, different cause. No owner means no identity to send
  // as. Queueing here would buy a full generation for a row the send path now
  // refuses outright — and before this order it bought a delivery from the
  // shared fallback mailbox instead.
  if (ownerMissing) {
    logger.warn(
      { prospectId, stage, cycle, automatic: options.automatic },
      "F-3.6b: not queueing — this prospect has no owning account, so there is no Gmail grant to send from.",
    );
    return { queued: false, revived: false, held: "owner_missing" };
  }

  // The uq_followups_prospect_cycle_stage unique index means a blind INSERT
  // blocks if any prior row exists at this (cycle, stage) — including
  // 'cancelled' rows left behind by a previous pause/cancel. Detect such rows
  // and revive them in place; otherwise insert fresh.
  // Never touches rows that are already 'sent' or currently active.
  //
  // F-3.6b: `cycle` is in the WHERE. Without it this lookup addressed
  // `(prospect_id, stage)` — half the unique key — with `.limit(1)` and no
  // ORDER BY, so for a renewed AntiGhosting prospect it could return the
  // PREVIOUS cycle's row. When that row was `sent` the function answered
  // `{queued: false}` and the new cycle's stage was never queued at all.
  const existing = await db
    .select({
      id: followupsTable.id,
      status: followupsTable.status,
      retryCount: followupsTable.retryCount,
      failureReason: followupsTable.failureReason,
      errorMessage: followupsTable.errorMessage,
      errorHistory: followupsTable.errorHistory,
    })
    .from(followupsTable)
    .where(and(
      eq(followupsTable.prospectId, prospectId),
      eq(followupsTable.cycle, cycle),
      eq(followupsTable.stage, stage),
    ))
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    const status = row.status;
    if (status === "sent") return { queued: false, revived: false };
    if (isActiveFollowupStatus(status)) return { queued: false, revived: false };

    // ── F-3.6a: the failed-row branch. ──────────────────────────────────
    if (status === "failed") {
      const decision = decideFailedRowAction({
        retryCount: row.retryCount ?? 0,
        failureReason: row.failureReason,
        // The RESOLVED value, not the raw option — the option is optional and
        // may have been looked up above. It is always false by the time we
        // reach here (the auth-dead guard returned early), and it is passed
        // so the policy sees exactly the inputs its tests give it.
        ownerAuthDead,
        // F-3.6b: likewise always false here, and passed for the same reason.
        // The policy reads CURRENT ownership, never the stale reason string —
        // a row that failed `owner_missing` and has since been given an owner
        // must retry, and must not pay a strike for the gap.
        ownerMissing,
      });

      // The automatic sweep obeys every hold. A human overrides
      // `retries_exhausted` and `stranded_needs_human` — those exist to stop
      // a LOOP, not to stop a person, and re-queueing a stranded row after
      // checking the thread is the documented resolution.
      if (options.automatic && decision.action === "hold") {
        logger.info(
          {
            followupId: row.id,
            prospectId,
            stage,
            retryCount: row.retryCount ?? 0,
            failureReason: row.failureReason,
            hold: decision.reason,
          },
          "F-3.6a: failed follow-up held — not auto-revived (it stays visible on the admin surface)",
        );
        return { queued: false, revived: false, held: decision.reason };
      }

      // Retrying (or a human overriding a hold). Preserve the evidence of
      // the attempt we are about to replace, then move the row.
      const nextRetryCount =
        decision.action === "retry" ? decision.nextRetryCount : (row.retryCount ?? 0) + 1;
      const history = appendFailure(
        row.errorHistory,
        makeFailureRecord({
          reason: row.failureReason ?? "send_error",
          error: row.errorMessage ?? "(no error text recorded)",
          attempt: row.retryCount ?? 0,
          now: new Date(),
        }),
      );

      const retryResult = await db
        .update(followupsTable)
        .set({
          status: "queued",
          scheduledAt,
          retryCount: nextRetryCount,
          errorHistory: history,
          // Deliberately NOT cleared: errorMessage, failureReason,
          // generatedBody, generatedSubject, gmailMessageId, draftMessageId,
          // sentAt. Minimal mutation is maximal evidence — and if this row
          // failed AFTER a Gmail send, gmailMessageId is the only record
          // that it went out at all.
        })
        .where(and(
          eq(followupsTable.id, row.id),
          eq(followupsTable.status, status),
        ));
      const retried = Boolean(retryResult.rowCount);
      if (retried) {
        logger.info(
          {
            followupId: row.id,
            prospectId,
            stage,
            attempt: nextRetryCount,
            of: MAX_AUTO_RETRIES,
            failureReason: row.failureReason,
            automatic: options.automatic,
          },
          "F-3.6a: retrying a failed follow-up, error history preserved",
        );
      }
      return { queued: retried, revived: retried };
    }

    const updateResult = await db
      .update(followupsTable)
      .set({
        status: "queued",
        scheduledAt,
        draftMessageId: null,
        errorMessage: null,
        gmailMessageId: null,
        generatedBody: null,
        generatedSubject: null,
        sentAt: null,
      })
      // CAS: revive only if the row still has the status we just read.
      // Without this guard, a row revived-and-claimed ('generating') by a
      // concurrent worker between our SELECT and UPDATE would be reset to
      // 'queued' here — un-claiming an in-flight generation and opening a
      // double-generate/double-send window.
      .where(and(
        eq(followupsTable.id, existing[0].id),
        eq(followupsTable.status, status),
      ));
    const did = Boolean(updateResult.rowCount);
    return { queued: did, revived: did };
  }

  // No prior row. Insert. onConflictDoNothing guards a concurrent-insert
  // race (e.g., autoQueue running in parallel inserting first).
  //
  // F-3.6b: `cycle` is written. It used to be omitted, so every row this
  // function created took the column default of 1 — which is correct for
  // doctrine and context, and silently wrong for a renewed AntiGhosting
  // campaign, whose stage belongs to cycle 2.
  const insertResult = await db
    .insert(followupsTable)
    .values({ prospectId, cycle, stage, scheduledAt, status: "queued" })
    .onConflictDoNothing();
  return { queued: Boolean(insertResult.rowCount), revived: false };
}

export async function cancelActiveFollowupsForProspects(
  prospectIds: number[],
  reason = "Campaign paused; active follow-up cancelled.",
): Promise<number> {
  if (prospectIds.length === 0) return 0;

  const drafted = await db
    .select({
      followupId: followupsTable.id,
      draftId: followupsTable.draftMessageId,
      userId: prospectsTable.userId,
      userEmail: usersTable.email,
      userRefreshToken: usersTable.googleRefreshToken,
      userConnected: usersTable.isConnected,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
    .where(and(
      inArray(followupsTable.prospectId, prospectIds),
      eq(followupsTable.status, "drafted"),
    ));

  for (const row of drafted) {
    if (!row.draftId || !row.userRefreshToken || !row.userConnected || !row.userEmail) continue;
    const gmail = getGmailForUser({ refreshToken: row.userRefreshToken, email: row.userEmail });
    await deleteDraft({ draftId: row.draftId, gmail });
  }

  const result = await db
    .update(followupsTable)
    .set({
      status: "cancelled",
      draftMessageId: null,
      errorMessage: reason,
    })
    .where(and(
      inArray(followupsTable.prospectId, prospectIds),
      inArray(followupsTable.status, ACTIVE_FOLLOWUP_STATUSES),
    ));

  return result.rowCount || 0;
}

export async function stallDraftedFollowups(options?: { now?: Date }): Promise<number> {
  const now = options?.now ?? new Date();
  const cutoff = new Date(now.getTime() - DRAFT_STALL_DAYS * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      followupId: followupsTable.id,
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      scheduledAt: followupsTable.scheduledAt,
      draftId: followupsTable.draftMessageId,
      userId: prospectsTable.userId,
      userEmail: usersTable.email,
      userRefreshToken: usersTable.googleRefreshToken,
      userConnected: usersTable.isConnected,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
    .where(and(
      eq(followupsTable.status, "drafted"),
      lte(followupsTable.scheduledAt, cutoff),
    ));

  let stalled = 0;
  for (const row of rows) {
    try {
      if (row.draftId && row.userRefreshToken && row.userConnected && row.userEmail) {
        const gmail = getGmailForUser({ refreshToken: row.userRefreshToken, email: row.userEmail });
        await deleteDraft({ draftId: row.draftId, gmail });
      }

      const updateResult = await db
        .update(followupsTable)
        .set({
          status: STALLED_AWAITING_MANUAL_SEND,
          draftMessageId: null,
          errorMessage: `Draft follow-up stage ${row.stage} stalled after ${DRAFT_STALL_DAYS} days without manual send.`,
        })
        .where(and(eq(followupsTable.id, row.followupId), eq(followupsTable.status, "drafted")));

      if (updateResult.rowCount && updateResult.rowCount > 0) {
        await db
          .update(prospectsTable)
          .set({ followupPaused: true })
          .where(eq(prospectsTable.id, row.prospectId));
        stalled++;
      }
    } catch (err) {
      logger.error({ err, followupId: row.followupId }, "Failed to stall drafted follow-up");
    }
  }

  return stalled;
}

export async function autoQueueAllCampaigns(): Promise<number> {
  // Global pause stops new stages from being queued for anyone.
  if (await isGlobalPauseEnabled()) {
    logger.info("Global pause active — skipping auto-queue");
    return 0;
  }
  // Fetch the full user record for every connected user up front. We used to
  // re-fetch the full record from inside the per-prospect loop below, which
  // produced an N+1 (one DB round-trip per prospect). For a single user with
  // many prospects this dominated wall-clock time on each sync tick.
  // B7u: exclude paused users from sync. Admin-paused users do not
  // auto-queue new stages until they are resumed.
  // F-3.6a: and exclude auth-dead users. Their grant is refused by Google,
  // so every stage queued for them is generated at full LLM cost and then
  // fails at the send — 196 follow-ups and 75% of a week's spend on
  // 2026-08-09. Queueing stops until the grant heals; nothing is cancelled.
  const connectedUsers = await db
    .select()
    .from(usersTable)
    .where(and(
      eq(usersTable.isConnected, true),
      eq(usersTable.pausedByAdmin, false),
      isNull(usersTable.authDeadAt),
    ));

  // 2026-07-29 admin-pause visibility: sync still INGESTS prospects for
  // admin-paused users (ingest filters only isConnected), but this function
  // silently skipped them, so their freshly-synced campaigns sat invisible —
  // prospect row present, no follow-up ever queued, empty Pipeline, no
  // signal anywhere (2026-07-29 incident, michael@mobupps.com). Keep the
  // skip (that's what admin-pause means) but say so loudly every tick.
  const adminPausedConnected = await db
    .select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(and(eq(usersTable.isConnected, true), eq(usersTable.pausedByAdmin, true)));
  if (adminPausedConnected.length > 0) {
    logger.warn(
      { users: adminPausedConnected.map((u) => u.email) },
      "Auto-queue skipping admin-paused users — their synced prospects will NOT get follow-ups queued until resumed",
    );
  }

  // F-3.6a: same treatment for auth-dead accounts. Same failure shape as the
  // 2026-07-29 admin-pause incident — prospects keep arriving, nothing is
  // ever queued — so it gets the same loud line every tick, plus the
  // operator-visible badge on the Accounts page.
  const authDeadConnected = await db
    .select({ id: usersTable.id, email: usersTable.email, authDeadAt: usersTable.authDeadAt })
    .from(usersTable)
    .where(and(eq(usersTable.isConnected, true), isNotNull(usersTable.authDeadAt)));
  if (authDeadConnected.length > 0) {
    logger.warn(
      {
        users: authDeadConnected.map((u) => ({
          email: u.email,
          deadSince: u.authDeadAt?.toISOString() ?? null,
        })),
      },
      "Auto-queue skipping AUTH-DEAD users — Google refuses their grant, so nothing is queued or generated until they reconnect",
    );
  }

  if (connectedUsers.length === 0) return 0;

  const userIds = connectedUsers.map((u) => u.id);
  const userById = new Map<number, typeof usersTable.$inferSelect>(
    connectedUsers.map((u) => [u.id, u]),
  );
  const maxFollowupsMap = new Map<number, number>(
    connectedUsers.map((u) => [u.id, getFollowupCap(u.maxFollowups)]),
  );

  const unrepliedProspects = await db
    .select({
      id: prospectsTable.id,
      userId: prospectsTable.userId,
      sentAt: prospectsTable.sentAt,
      batchLabel: prospectsTable.batchLabel,
      // CSD v1: cohort columns for same-time scheduling alignment.
      app: prospectsTable.app,
      company: prospectsTable.company,
      originalLanguage: prospectsTable.originalLanguage,
      vertical: prospectsTable.vertical,
      subVertical: prospectsTable.subVertical,
      product: prospectsTable.product,
      // F-3.6b: the renewal cycle. Selected here so the sweep can scope stage
      // counting to it and hand it to queueStageForProspect without a second
      // round-trip per prospect.
      cycle: prospectsTable.cycle,
    })
    .from(prospectsTable)
    .where(
      and(
        // B9b.12.5: AG prospects can be auto-queued past replied (manual re-engagement).
        or(eq(prospectsTable.replied, 0), eq(prospectsTable.app, "anti_ghosting"))!,
        eq(prospectsTable.followupPaused, false),
        eq(prospectsTable.archived, false),
        inArray(prospectsTable.userId, userIds),
      ),
    );

  if (unrepliedProspects.length === 0) return 0;

  const prospectIds = unrepliedProspects.map(p => p.id);
  const existingFollowups = await db
    .select({
      id: followupsTable.id,
      prospectId: followupsTable.prospectId,
      cycle: followupsTable.cycle,
      stage: followupsTable.stage,
      status: followupsTable.status,
      sentAt: followupsTable.sentAt,
    })
    .from(followupsTable)
    .where(inArray(followupsTable.prospectId, prospectIds));

  // F-3.6b: group by prospect, then let campaignPosition() apply the cycle
  // scope per prospect. The previous version folded every cycle's rows into
  // one running maximum, so a renewed AntiGhosting campaign inherited the
  // finished cycle's stage count: nextStage came out 4 on a cycle that had
  // sent nothing, the follow-up cap rejected it, and the campaign was skipped
  // on every tick for ever. Doctrine and context are all cycle 1, so the
  // scoped and unscoped answers are identical for them.
  const rowsByProspect = new Map<number, StageRow[]>();
  for (const f of existingFollowups) {
    const list = rowsByProspect.get(f.prospectId) || [];
    list.push(f);
    rowsByProspect.set(f.prospectId, list);
  }

  let queued = 0;

  // CSD v1: two-pass queueing.
  //
  // Pass 1 keeps every pre-existing skip rule (active follow-up exists,
  // max-followups cap) and collects a plan entry per eligible prospect.
  //
  // Between passes, doctrine prospects that share a cohort (same user,
  // normalized company, ORIGINAL THREAD LANGUAGE, vertical, sub-vertical,
  // product, batch key) AND land on the same next stage are assigned ONE
  // identical scheduledAt, anchored on the cohort's latest member so the
  // configured minimum gap holds for everyone. Sending all cohort contacts
  // at the same time is an accepted product decision; it also makes the
  // shared-draft cache hit while the draft is hours old rather than days.
  // Singletons and non-doctrine prospects keep the exact per-prospect
  // computation from before.
  type QueuePlanItem = {
    prospectId: number;
    cycle: number;
    nextStage: number;
    sentAt: Date;
    lastFollowupSentAt: Date | null;
    userFull: typeof usersTable.$inferSelect | undefined;
    alignmentKey: string | null;
    scheduledAt?: Date;
  };

  const plan: QueuePlanItem[] = [];

  for (const prospect of unrepliedProspects) {
    const cycle = prospect.cycle ?? 1;
    const position = campaignPosition(rowsByProspect.get(prospect.id) ?? [], cycle);
    // Skip if there's already an active (queued/generating/pending/drafted)
    // follow-up IN THIS CYCLE.
    if (position.hasActive) continue;

    const userFull = prospect.userId ? userById.get(prospect.userId) : undefined;
    const maxFollowups = maxFollowupsMap.get(prospect.userId!);
    const nextStage = position.nextStage;
    if (maxFollowups !== undefined && nextStage > maxFollowups) continue;

    plan.push({
      prospectId: prospect.id,
      cycle,
      nextStage,
      sentAt: new Date(prospect.sentAt),
      lastFollowupSentAt: position.lastSentAt ? new Date(position.lastSentAt) : null,
      userFull,
      alignmentKey: buildAlignmentKey({
        userId: prospect.userId,
        app: prospect.app,
        company: prospect.company,
        originalLanguage: prospect.originalLanguage,
        vertical: prospect.vertical,
        subVertical: prospect.subVertical,
        product: prospect.product,
        batchLabel: prospect.batchLabel || "",
        sentAt: new Date(prospect.sentAt),
        nextStage,
      }),
    });
  }

  const cohortGroups = new Map<string, QueuePlanItem[]>();
  for (const item of plan) {
    if (!item.alignmentKey) continue;
    const group = cohortGroups.get(item.alignmentKey) || [];
    group.push(item);
    cohortGroups.set(item.alignmentKey, group);
  }

  for (const [key, members] of cohortGroups) {
    if (members.length < 2) continue;
    const anchors = pickCohortAnchors(members.map((m) => ({
      sentAt: m.sentAt,
      lastFollowupSentAt: m.lastFollowupSentAt,
    })));
    // Cohort members share the same user (userId is in the alignment key),
    // so settings and mode come from any one member.
    const rep = members[0];
    const sharedScheduledAt = computeNextStageScheduledAt({
      stage: rep.nextStage,
      initialSentAt: anchors.initialSentAt,
      lastFollowupSentAt: anchors.lastFollowupSentAt,
      userSettings: rep.userFull ? buildUserTimingSettings(rep.userFull) : undefined,
      mode: getScheduleMode(rep.userFull),
    });
    for (const m of members) m.scheduledAt = sharedScheduledAt;
    logger.info(
      { cohortKey: key.split("\u241F").slice(1, 4).join("/"), members: members.length, stage: rep.nextStage, scheduledAt: sharedScheduledAt.toISOString() },
      "CSD: aligned cohort follow-ups to a single scheduled time",
    );
  }

  for (const item of plan) {
    const userSettings = item.userFull ? buildUserTimingSettings(item.userFull) : undefined;
    const scheduledAt = item.scheduledAt ?? computeNextStageScheduledAt({
      stage: item.nextStage,
      initialSentAt: item.sentAt,
      lastFollowupSentAt: item.lastFollowupSentAt,
      userSettings,
      mode: getScheduleMode(item.userFull),
    });

    try {
      // F-3.6a: this is THE automatic sweep — the one that used to wipe a
      // failed row's evidence every 15 minutes. `ownerAuthDead: false` is
      // guaranteed by construction: the connectedUsers query that produced
      // `plan` already excludes auth-dead accounts.
      // F-3.6b: `cycle` and `ownerMissing` are supplied by construction too —
      // the prospect query selected the cycle, and its `user_id IN (…)` filter
      // means every planned prospect has an owner. The hot loop still costs no
      // extra query per row.
      const { queued: didQueue, revived } = await queueStageForProspect(
        item.prospectId,
        item.nextStage,
        scheduledAt,
        { ownerAuthDead: false, ownerMissing: false, cycle: item.cycle, automatic: true },
      );
      if (didQueue) {
        queued++;
        logger.info(
          {
            prospectId: item.prospectId,
            cycle: item.cycle,
            stage: item.nextStage,
            scheduledAt: scheduledAt.toISOString(),
            followupMode: item.userFull?.followupMode || "auto_send",
            revived,
            cohortAligned: Boolean(item.scheduledAt),
          },
          revived ? "Auto-queued next follow-up stage (revived cancelled row)" : "Auto-queued next follow-up stage",
        );
      }
    } catch (err) {
      logger.error({ err, prospectId: item.prospectId, stage: item.nextStage }, "Failed to auto-queue follow-up stage");
    }
  }

  return queued;
}

const ARCHIVE_AFTER_DAYS = 14;

// RH-1: a follow-up stranded in 'generating' for many hours means the
// process died or a database write failed between the claim and the final
// status write. Such a row silently freezes its whole campaign: the
// auto-queue sees an active row and never schedules the next stage.
// F-3.6a: the threshold and the classifier moved to lib/strandedGenerating.ts
// so the recovery pass and its tests share one definition. Value unchanged.

/**
 * RH-1 + F-3.6a: recover follow-ups stranded in 'generating'.
 *
 * RH-1 made this a DETECTOR on purpose, and the reason still stands: a row
 * can strand AFTER the Gmail send and BEFORE the status write, so an
 * automatic re-queue can deliver a second copy of the same email. That rule
 * is preserved exactly.
 *
 * What RH-1 did not fix is that `generating` is in ACTIVE_FOLLOWUP_STATUSES,
 * so a stranded row makes auto-queue believe the campaign is busy and no
 * further stage is ever scheduled. The campaign freezes, invisibly, for
 * ever — two production rows had been frozen since 2026-07-21 and 07-28 when
 * F-D4 found them on 08-09, and the only place their count was recorded was
 * a heartbeat no surface could read.
 *
 * So F-3.6a moves them: `generating` → `failed`, reason `stranded`, with the
 * evidence written onto the row. That unfreezes the campaign and puts the row
 * on the admin surface. It does NOT hand it to the retry loop —
 * `decideFailedRowAction` treats `stranded` as terminal, so nothing is
 * auto-resent. A human resolves it from the pipeline: mark sent if the thread
 * shows it went out, Send-Now if it did not.
 *
 * Returns the number of rows recovered.
 */
export async function detectStrandedGeneratingFollowups(options?: { now?: Date }): Promise<number> {
  const now = options?.now ?? new Date();
  const cutoff = strandedCutoff(now, GENERATING_STRAND_HOURS);

  const rows = await db
    .select({
      followupId: followupsTable.id,
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      scheduledAt: followupsTable.scheduledAt,
      errorHistory: followupsTable.errorHistory,
      retryCount: followupsTable.retryCount,
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      userId: prospectsTable.userId,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(
      eq(followupsTable.status, "generating"),
      lt(followupsTable.scheduledAt, cutoff),
    ));

  if (rows.length === 0) return 0;

  logger.error(
    {
      count: rows.length,
      followups: rows.map((r) => ({
        followupId: r.followupId,
        prospectId: r.prospectId,
        stage: r.stage,
        company: r.company,
        userId: r.userId,
        scheduledAt: r.scheduledAt.toISOString(),
      })),
    },
    `RH-1: follow-ups stranded in 'generating' for over ${GENERATING_STRAND_HOURS}h — moving them to 'failed' so the campaigns unfreeze. NOT auto-retried: check the Gmail thread (mark sent if delivered, Send-Now if not)`,
  );

  let recovered = 0;
  for (const row of rows) {
    try {
      const message = strandedErrorMessage(row.scheduledAt, now, GENERATING_STRAND_HOURS);
      const history = appendFailure(
        row.errorHistory,
        makeFailureRecord({
          reason: "stranded",
          error: message,
          attempt: row.retryCount ?? 0,
          now,
        }),
      );

      const result = await db
        .update(followupsTable)
        .set({
          status: "failed",
          failureReason: "stranded",
          errorMessage: message,
          errorHistory: history,
        })
        // CAS on the status AND the age predicate: a row that finished
        // generating between the SELECT above and this UPDATE keeps its real
        // result. Nothing that completed is ever overwritten.
        .where(and(
          eq(followupsTable.id, row.followupId),
          eq(followupsTable.status, "generating"),
          lt(followupsTable.scheduledAt, cutoff),
        ));

      if (result.rowCount) recovered++;
    } catch (err) {
      logger.error(
        { err, followupId: row.followupId },
        "F-3.6a: failed to recover a stranded 'generating' row — it stays stranded and will be retried next tick",
      );
    }
  }

  logger.warn({ found: rows.length, recovered }, "F-3.6a: stranded-generating recovery pass complete");
  return recovered;
}

/**
 * Daily archival sweep.
 *
 * Two steps, both idempotent:
 *   1. Stamp paused_at = NOW() on any paused row that still has null there.
 *      This gives every pause site a clock without each one writing the
 *      column, and starts the 14-day window from the first sweep that sees
 *      the pause.
 *   2. Archive any prospect paused for >= 14 days. Archived rows drop out of
 *      the active pipeline lists, the dispatcher, and the auto-queue. The row
 *      and its thread history are preserved, so a re-ingest does not recreate
 *      it and the audit trail survives.
 *
 * Returns the number of prospects archived in this run.
 */
export async function archiveStalePausedCampaigns(options?: {
  now?: Date;
  days?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const days = options?.days ?? ARCHIVE_AFTER_DAYS;

  // Step 1: stamp the clock on any paused row missing paused_at.
  await db
    .update(prospectsTable)
    .set({ pausedAt: now })
    .where(and(eq(prospectsTable.followupPaused, true), isNull(prospectsTable.pausedAt)));

  // Step 2: archive rows paused long enough.
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const result = await db
    .update(prospectsTable)
    .set({ archived: true, archivedAt: now })
    .where(
      and(
        eq(prospectsTable.followupPaused, true),
        eq(prospectsTable.archived, false),
        isNotNull(prospectsTable.pausedAt),
        lt(prospectsTable.pausedAt, cutoff),
      ),
    );

  return result.rowCount || 0;
}

// CB-3: the campaign-expiry pause reason and the cancel message stamped
// when the 30-day sweep stops a campaign. Named constants keep the reason a
// row was paused unambiguous in history and audit.
const CAMPAIGN_EXPIRED_PAUSE_REASON = "campaign_expired_30d" as const;
const CAMPAIGN_EXPIRED_CANCEL_MESSAGE =
  "Campaign auto-paused after 30 days; active follow-up cancelled.";

/**
 * CB-3: daily 30-day expiry sweep.
 *
 * Force-pauses every active campaign whose original outreach was sent more
 * than CAMPAIGN_MAX_AGE_DAYS ago, across all three subproducts. It cancels
 * any active follow-up rows first (deleting their Gmail drafts where
 * present), then pauses the campaign with pause_reason='campaign_expired_30d'
 * and stamps paused_at so the existing 14-day archival sweep takes over.
 *
 * Running this once also performs the one-time backfill: every already-
 * active campaign past 30 days is paused on the first run.
 *
 * "Active" means not already paused and not archived. A replied campaign is
 * paused at reply time, so followup_paused is already true and the sweep
 * skips it.
 *
 * Returns the number of campaigns paused in this run.
 */
export async function pauseExpiredCampaigns(options?: {
  now?: Date;
  days?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const days = options?.days ?? CAMPAIGN_MAX_AGE_DAYS;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const expired = await db
    .select({ id: prospectsTable.id })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.followupPaused, false),
      eq(prospectsTable.archived, false),
      lt(prospectsTable.sentAt, cutoff),
    ));

  if (expired.length === 0) return 0;
  const ids = expired.map((p) => p.id);

  // Cancel active follow-up rows first so no in-flight stage sends after the
  // pause. This also deletes any Gmail draft a drafted row created.
  await cancelActiveFollowupsForProspects(ids, CAMPAIGN_EXPIRED_CANCEL_MESSAGE);

  const result = await db
    .update(prospectsTable)
    .set({
      followupPaused: true,
      pauseReason: CAMPAIGN_EXPIRED_PAUSE_REASON,
      pausedAt: now,
    })
    .where(and(
      eq(prospectsTable.followupPaused, false),
      eq(prospectsTable.archived, false),
      lt(prospectsTable.sentAt, cutoff),
    ));

  const paused = result.rowCount || 0;
  if (paused > 0) {
    logger.info(
      { paused, cutoff: cutoff.toISOString(), days },
      "CB-3: 30-day expiry sweep paused campaigns past the maximum age",
    );
  }
  return paused;
}

// Pause reason + cancel message for the over-cap sweep: campaigns that have
// already SENT more follow-ups than the rigid cap allows (legacy rows from
// before HARD_FOLLOWUP_CAP, or any future drift). A distinct reason keeps the
// row's history unambiguous and lets the pipeline show why it stopped.
const OVER_CAP_PAUSE_REASON = "over_followup_cap" as const;
const OVER_CAP_CANCEL_MESSAGE =
  "Campaign auto-paused: more follow-ups already sent than the cap allows; active follow-up cancelled.";

/**
 * Daily over-cap sweep.
 *
 * Force-pauses every ACTIVE campaign that has already SENT more than
 * HARD_FOLLOWUP_CAP follow-ups, across all subproducts. The scheduler will not
 * queue past the cap going forward, so this only ever catches legacy rows that
 * over-sent before the cap existed — but it makes the "max 3 follow-ups"
 * invariant true for the stored data, not just for new sends, which is what the
 * operator asked for ("auto-pause any campaign that did more than 3
 * follow-ups, for any user").
 *
 * "Active" means not already paused and not archived. A replied campaign is
 * already paused, so the sweep skips it.
 *
 * Returns the number of campaigns paused in this run.
 */
export async function pauseOverCapCampaigns(options?: {
  now?: Date;
  cap?: number;
}): Promise<number> {
  const now = options?.now ?? new Date();
  const cap = options?.cap ?? HARD_FOLLOWUP_CAP;

  // Prospect ids that sent more than the cap WITHIN A SINGLE CYCLE. Grouping
  // by (prospect, cycle) matters because AntiGhosting renewals re-use stage
  // numbers across cycles and may legitimately send up to the cap each cycle —
  // counting all cycles together would wrongly flag them. Doctrine/context are
  // always cycle=1, so this reduces to per-prospect for them. A prospect over
  // the cap in more than one cycle appears more than once; the Set dedupes.
  const overCap = await db
    .select({ prospectId: followupsTable.prospectId })
    .from(followupsTable)
    .where(eq(followupsTable.status, "sent"))
    .groupBy(followupsTable.prospectId, followupsTable.cycle)
    .having(sql`count(*) > ${cap}`);
  if (overCap.length === 0) return 0;
  const overCapIds = Array.from(new Set(overCap.map((r) => r.prospectId)));

  // Of those, the ones still active (not paused, not archived).
  const active = await db
    .select({ id: prospectsTable.id })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.followupPaused, false),
      eq(prospectsTable.archived, false),
      inArray(prospectsTable.id, overCapIds),
    ));
  if (active.length === 0) return 0;
  const ids = active.map((p) => p.id);

  // Cancel any active follow-up rows first (deletes their Gmail drafts where
  // present), then pause.
  await cancelActiveFollowupsForProspects(ids, OVER_CAP_CANCEL_MESSAGE);

  const result = await db
    .update(prospectsTable)
    .set({
      followupPaused: true,
      pauseReason: OVER_CAP_PAUSE_REASON,
      pausedAt: now,
    })
    .where(inArray(prospectsTable.id, ids));

  const paused = result.rowCount || 0;
  if (paused > 0) {
    logger.info(
      { paused, cap },
      "Over-cap sweep paused campaigns that had already sent more than the cap",
    );
  }
  return paused;
}
