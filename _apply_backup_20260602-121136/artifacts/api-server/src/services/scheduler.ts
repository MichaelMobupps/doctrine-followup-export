import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { eq, ne, and, lte, lt, inArray, or, isNull, isNotNull } from "drizzle-orm";
import { generateFollowupEmail } from "./followupGenerator";
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
import { generateContextFollowup } from "./contextFollowupGenerator";
// B7r: usage context import. Wraps generator calls so the recordUsage
// helper inside the generators knows which followup the LLM call is for.
import { runWithUsageContext } from "../lib/usageContext";
// Global pause switch: when on, bulk cron processing and bulk auto-queue stop.
import { isGlobalPauseEnabled } from "../lib/globalPause";

const ACTIVE_FOLLOWUP_STATUSES = ["queued", "generating", "pending_approval", "drafted"];
const STALLED_AWAITING_MANUAL_SEND = "stalled_awaiting_manual_send";
const DRAFT_STALL_DAYS = 30;

function getFollowupCap(maxFollowups?: number | null): number | null {
  return typeof maxFollowups === "number" && maxFollowups > 0 ? maxFollowups : null;
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

export async function processDueFollowups(options?: {
  followupId?: number;
  forceSend?: boolean;
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
    .where(and(...conditions))
    .orderBy(followupsTable.scheduledAt)
    .limit(20);

  if (due.length === 0) {
    return { processed: 0, sent: 0, drafted: 0, failed: 0 };
  }

  logger.info({ count: due.length }, "Processing due follow-ups");

  const userCache = new Map<number, typeof usersTable.$inferSelect>();

  let sent = 0;
  let drafted = 0;
  let failed = 0;

  for (const item of due) {
    try {
      let senderEmail = process.env.SENDER_EMAIL || "";
      let senderName = process.env.SENDER_NAME || "Team";
      let gmail = undefined;

      if (item.userId) {
        if (!userCache.has(item.userId)) {
          const users = await db.select().from(usersTable).where(eq(usersTable.id, item.userId)).limit(1);
          if (users.length > 0) userCache.set(item.userId, users[0]);
        }
        const user = userCache.get(item.userId);
        if (user && user.googleRefreshToken && user.isConnected) {
          senderEmail = user.email;
          senderName = user.name || user.email.split("@")[0];
          gmail = getGmailForUser({ refreshToken: user.googleRefreshToken, email: user.email });
        }
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
      }
      if (item.userId && !gmail) {
        logger.warn(
          { followupId: item.followupId, prospectId: item.prospectId, userId: item.userId },
          "User Gmail credentials unavailable — skipping follow-up",
        );
        continue;
      }

      if (!senderEmail) {
        logger.warn({ followupId: item.followupId, prospectId: item.prospectId }, "No sender credentials available — skipping");
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
      // Phase 7b: route generation by product. Doctrine flow uses the
      // doctrine prompts + 3-call pipeline. Context flow uses its own
      // prompts (no doctrine, faithful-to-context).
      // B7r: wrap generator dispatch with the usage context so
      // recordUsageBestEffort() inside the generator knows what to attribute.
      const generated = await runWithUsageContext(
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
          // context share the FollowupContext.
          if (item.app === "anti_ghosting" && antiGhostingCtx) {
            return generateAntiGhostingFollowup(antiGhostingCtx);
          }
          return item.app === "context"
            ? generateContextFollowup(ctx)
            : generateFollowupEmail(ctx);
        },
      );

      if (needsApproval) {
        await db
          .update(followupsTable)
          .set({
            status: "pending_approval",
            generatedBody: generated.body,
            generatedSubject: generated.subject,
          })
          .where(eq(followupsTable.id, item.followupId));

        logger.info(
          { prospect: item.prospectName },
          "Follow-up generated, pending approval",
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
      logger.error(
        { err, followupId: item.followupId },
        "Failed follow-up",
      );

      await db
        .update(followupsTable)
        .set({ status: "failed", errorMessage: errorMsg })
        .where(eq(followupsTable.id, item.followupId));

      failed++;
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
      stage: followupsTable.stage,
      status: followupsTable.status,
      sentAt: followupsTable.sentAt,
    })
    .from(followupsTable)
    .where(eq(followupsTable.prospectId, prospectId));

  if (existingFollowups.some((f) => isActiveFollowupStatus(f.status))) {
    return { queued: false, stage: null, scheduledAt: null, reason: "active_followup_exists" };
  }

  const sentRows = existingFollowups.filter((f) => f.status === "sent");
  const lastSentRow = sentRows.length > 0
    ? sentRows.reduce((a, b) => (a.stage > b.stage ? a : b))
    : null;
  const nextStage = lastSentRow ? lastSentRow.stage + 1 : 1;
  const maxFollowups = getFollowupCap(user.maxFollowups);

  if (maxFollowups !== null && nextStage > maxFollowups) {
    return { queued: false, stage: nextStage, scheduledAt: null, reason: "max_followups_reached" };
  }

  const scheduledAt = computeNextStageScheduledAt({
    stage: nextStage,
    initialSentAt: prospect.sentAt,
    lastFollowupSentAt: lastSentRow?.sentAt ?? null,
    userSettings: buildUserTimingSettings(user),
    mode: getScheduleMode(user),
  });

  const { queued: didQueue } = await queueStageForProspect(prospectId, nextStage, scheduledAt);

  return {
    queued: didQueue,
    stage: nextStage,
    scheduledAt,
    reason: didQueue ? undefined : "insert_conflict",
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

export async function queueStageForProspect(
  prospectId: number,
  stage: number,
  scheduledAt: Date,
): Promise<{ queued: boolean; revived: boolean }> {
  // The uq_followups_prospect_stage unique index on (prospect_id, stage)
  // means a blind INSERT blocks if any prior row exists at this stage —
  // including 'cancelled' rows left behind by a previous pause/cancel.
  // Detect such rows and revive them in place; otherwise insert fresh.
  // Never touches rows that are already 'sent' or currently active.
  const existing = await db
    .select({ id: followupsTable.id, status: followupsTable.status })
    .from(followupsTable)
    .where(and(
      eq(followupsTable.prospectId, prospectId),
      eq(followupsTable.stage, stage),
    ))
    .limit(1);

  if (existing[0]) {
    const status = existing[0].status;
    if (status === "sent") return { queued: false, revived: false };
    if (isActiveFollowupStatus(status)) return { queued: false, revived: false };
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
      .where(eq(followupsTable.id, existing[0].id));
    const did = Boolean(updateResult.rowCount);
    return { queued: did, revived: did };
  }

  // No prior row. Insert. onConflictDoNothing guards a concurrent-insert
  // race (e.g., autoQueue running in parallel inserting first).
  const insertResult = await db
    .insert(followupsTable)
    .values({ prospectId, stage, scheduledAt, status: "queued" })
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
  const connectedUsers = await db
    .select()
    .from(usersTable)
    .where(and(eq(usersTable.isConnected, true), eq(usersTable.pausedByAdmin, false)));

  if (connectedUsers.length === 0) return 0;

  const userIds = connectedUsers.map((u) => u.id);
  const userById = new Map<number, typeof usersTable.$inferSelect>(
    connectedUsers.map((u) => [u.id, u]),
  );
  const maxFollowupsMap = new Map<number, number | null>(
    connectedUsers.map((u) => [u.id, getFollowupCap(u.maxFollowups)]),
  );

  const unrepliedProspects = await db
    .select({
      id: prospectsTable.id,
      userId: prospectsTable.userId,
      sentAt: prospectsTable.sentAt,
      batchLabel: prospectsTable.batchLabel,
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
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      status: followupsTable.status,
      sentAt: followupsTable.sentAt,
    })
    .from(followupsTable)
    .where(inArray(followupsTable.prospectId, prospectIds));

  const prospectFollowupMap = new Map<number, { maxSentStage: number; hasActive: boolean; lastSentAt: Date | null }>();
  for (const f of existingFollowups) {
    const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasActive: false, lastSentAt: null };
    if (f.status === "sent" && f.stage > entry.maxSentStage) {
      entry.maxSentStage = f.stage;
      entry.lastSentAt = f.sentAt;
    }
    if (isActiveFollowupStatus(f.status)) entry.hasActive = true;
    prospectFollowupMap.set(f.prospectId, entry);
  }

  let queued = 0;

  for (const prospect of unrepliedProspects) {
    const info = prospectFollowupMap.get(prospect.id);
    // Skip if there's already an active (queued/generating/pending/drafted) follow-up.
    if (info?.hasActive) continue;

    const userFull = prospect.userId ? userById.get(prospect.userId) : undefined;
    const maxFollowups = maxFollowupsMap.get(prospect.userId!);
    const maxSent = info?.maxSentStage || 0;
    const nextStage = maxSent + 1;
    if (maxFollowups !== null && maxFollowups !== undefined && nextStage > maxFollowups) continue;

    const userSettings = userFull ? buildUserTimingSettings(userFull) : undefined;
    const scheduledAt = computeNextStageScheduledAt({
      stage: nextStage,
      initialSentAt: prospect.sentAt,
      lastFollowupSentAt: info?.lastSentAt ?? null,
      userSettings,
      mode: getScheduleMode(userFull),
    });

    try {
      const { queued: didQueue, revived } = await queueStageForProspect(prospect.id, nextStage, scheduledAt);
      if (didQueue) {
        queued++;
        logger.info(
          {
            prospectId: prospect.id,
            stage: nextStage,
            scheduledAt: scheduledAt.toISOString(),
            followupMode: userFull?.followupMode || "auto_send",
            revived,
          },
          revived ? "Auto-queued next follow-up stage (revived cancelled row)" : "Auto-queued next follow-up stage",
        );
      }
    } catch (err) {
      logger.error({ err, prospectId: prospect.id, stage: nextStage }, "Failed to auto-queue follow-up stage");
    }
  }

  return queued;
}

const ARCHIVE_AFTER_DAYS = 14;

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
