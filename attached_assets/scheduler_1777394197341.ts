import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { eq, and, lte, sql, isNull, lt, inArray, not } from "drizzle-orm";
import { generateFollowupEmail } from "./followupGenerator";
import { sendFollowupReply, getGmailForUser } from "./gmailClient";
import type { FollowupContext, PreviousFollowup } from "./followupPrompts";
import { logger } from "../lib/logger";
import { getScheduleWindow, generateScheduledTime } from "./timingEngine";

function getFollowupCap(maxFollowups?: number | null): number | null {
  return typeof maxFollowups === "number" && maxFollowups > 0 ? maxFollowups : null;
}

export async function processDueFollowups(options?: {
  followupId?: number;
  forceSend?: boolean;
}): Promise<{
  processed: number;
  sent: number;
  failed: number;
}> {
  const conditions = [
    eq(followupsTable.status, "queued"),
    lte(followupsTable.scheduledAt, new Date()),
  ];
  if (!options?.forceSend) {
    conditions.push(eq(prospectsTable.replied, 0));
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
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(...conditions))
    .orderBy(followupsTable.scheduledAt)
    .limit(20);

  if (due.length === 0) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  logger.info({ count: due.length }, "Processing due follow-ups");

  const userCache = new Map<number, typeof usersTable.$inferSelect>();

  let sent = 0;
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

      if (!senderEmail) {
        logger.warn({ followupId: item.followupId, prospectId: item.prospectId }, "No sender credentials available — skipping");
        continue;
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
      const needsApproval = options?.forceSend ? false : (user?.requireApproval ?? false);

      logger.info(
        { stage: item.stage, prospect: item.prospectName, company: item.company, userId: item.userId, needsApproval },
        "Generating follow-up",
      );
      const generated = await generateFollowupEmail(ctx);

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

  logger.info({ sent, failed }, "Follow-up processing done");

  return { processed: due.length, sent, failed };
}

export async function autoQueueNextStages(): Promise<number> {
  // DEPRECATED: test mode was removed. The "Send now" button is the only
  // immediate-send path. All scheduled auto-queueing now goes through
  // autoQueueAllCampaigns() which uses each user's production timing window.
  // This function is retained as a no-op for API/caller compatibility.
  return 0;
}

export async function autoQueueAllCampaigns(): Promise<number> {
  // Fetch the full user record for every connected user up front. We used to
  // re-fetch the full record from inside the per-prospect loop below, which
  // produced an N+1 (one DB round-trip per prospect). For a single user with
  // many prospects this dominated wall-clock time on each sync tick.
  const connectedUsers = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isConnected, true));

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
        eq(prospectsTable.replied, 0),
        eq(prospectsTable.followupPaused, false),
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
    })
    .from(followupsTable)
    .where(inArray(followupsTable.prospectId, prospectIds));

  const prospectFollowupMap = new Map<number, { maxSentStage: number; hasActive: boolean }>();
  for (const f of existingFollowups) {
    const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasActive: false };
    if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
    if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasActive = true;
    prospectFollowupMap.set(f.prospectId, entry);
  }

  let queued = 0;

  for (const prospect of unrepliedProspects) {
    const info = prospectFollowupMap.get(prospect.id);
    // Skip if there's already an active (queued/generating/pending) followup
    if (info?.hasActive) continue;

    const maxFollowups = maxFollowupsMap.get(prospect.userId!);
    const maxSent = info?.maxSentStage || 0;
    const nextStage = maxSent + 1;
    if (maxFollowups !== null && maxFollowups !== undefined && nextStage > maxFollowups) continue;

    // Test mode is deprecated — every prospect now uses the user's production
    // timing window. The "Send now" button in the UI is the only immediate-send
    // path. We ignore prospect.batchLabel here on purpose.
    const userFull = prospect.userId ? userById.get(prospect.userId) : undefined;
    const userSettings = userFull ? {
      stageTiming: userFull.stageTiming,
      sendDays: userFull.sendDays,
      sendHourStart: userFull.sendHourStart,
      sendHourEnd: userFull.sendHourEnd,
    } : undefined;
    const window = getScheduleWindow(nextStage, userSettings);
    const scheduledIso = generateScheduledTime(window, prospect.sentAt);
    let scheduledAt = new Date(scheduledIso);
    if (scheduledAt < new Date()) {
      scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
    }

    try {
      const result = await db.insert(followupsTable).values({
        prospectId: prospect.id,
        stage: nextStage,
        scheduledAt,
        status: "queued",
      }).onConflictDoNothing();
      if (result.rowCount && result.rowCount > 0) {
        queued++;
        logger.info(
          { prospectId: prospect.id, stage: nextStage, scheduledAt: scheduledAt.toISOString() },
          "Auto-queued next follow-up stage",
        );
      }
    } catch (err) {
      logger.error({ err, prospectId: prospect.id, stage: nextStage }, "Failed to auto-queue follow-up stage");
    }
  }

  return queued;
}
