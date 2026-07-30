import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { google, gmail_v1 } from "googleapis";
import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getGmailForUser } from "../services/gmailClient";
import { logger } from "../lib/logger";
// Phase 7l: timingEngine helpers for /prospect/:id/resume parity with doctrine.
import { computeNextStageScheduledAt } from "../services/timingEngine";
import type { UserTimingSettings } from "../services/timingEngine";
// Phase 7g: googleapis + getGmailForUser imports for /gmail/sent-emails.

/**
 * Context Based Followuper routes — Phase 7b.
 *
 * Mounted under /api/context/*. Mirrors the essential Doctrine routes
 * but scoped to prospects with app='context'. Sales-specific endpoints
 * (taxonomy filters, vertical-based stats, MMP-related actions) are
 * intentionally omitted — they have no place in the context flow.
 *
 * The 7c UI will consume these endpoints. After 7c ships, doctrine
 * routes will receive a parallel app='doctrine' filter so the two
 * products are visually isolated. Until then, the Context flow is
 * functional but the Doctrine UI may show context prospects mixed in.
 */

const router: IRouter = Router();

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  const expected = process.env.ADDON_API_KEY;

  if (!expected) {
    res.status(500).json({ error: "ADDON_API_KEY not set" });
    return;
  }

  if (!key || key !== expected) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}

router.use(authMiddleware);

// All prospect queries are scoped to app='context' via this constant. If
// a request includes ?userId=N, it's also scoped to that user.
const SCOPE = eq(prospectsTable.app, "context");

// Phase 7f: shared helper inlined for the /campaign/status aggregation.
// Mirrors the doctrine.ts copy (3 lines, no good place to extract yet).
function getFollowupCap(maxFollowups?: number | null): number | null {
  return typeof maxFollowups === "number" && maxFollowups > 0 ? maxFollowups : null;
}

// Phase 7g: helpers for /gmail/sent-emails (Context Email Inspector).
// Mirror the module-private helpers in routes/email-inspector.ts.
// Future cleanup: extract to a shared lib once a third consumer exists.

function getLegacyGmail(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

async function getGmailForRequest(req: Request): Promise<{ gmail: gmail_v1.Gmail; senderEmail: string }> {
  const userId = req.query.userId ? parseInt(req.query.userId as string) : null;

  if (userId) {
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (users.length > 0 && users[0].googleRefreshToken && users[0].isConnected) {
      return {
        gmail: getGmailForUser({ refreshToken: users[0].googleRefreshToken, email: users[0].email }),
        senderEmail: users[0].email.toLowerCase(),
      };
    }
  }

  return {
    gmail: getLegacyGmail(),
    senderEmail: (process.env.SENDER_EMAIL || "").toLowerCase(),
  };
}

function extractEmail(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/) || headerValue.match(/([^\s,]+@[^\s,]+)/);
  return match ? match[1].trim() : headerValue.trim();
}

function extractName(headerValue: string): string {
  const match = headerValue.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  const email = extractEmail(headerValue);
  return email.split("@")[0].replace(/[._-]/g, " ");
}

function isWithinSyncWindow(timestamp: number): boolean {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  return timestamp >= sixtyDaysAgo.getTime();
}

// ====================================================================
// GET /context/stats — pipeline counts
// ====================================================================
router.get("/stats", async (req: Request, res: Response) => {
  try {
    const userIdFilter = req.query.userId ? parseInt(req.query.userId as string) : null;

    const prospectConds = [SCOPE];
    if (userIdFilter) prospectConds.push(eq(prospectsTable.userId, userIdFilter));

    const prospectStats = await db
      .select({
        totalSent: sql<number>`count(*)::int`,
        unreplied: sql<number>`sum(case when ${prospectsTable.replied} = 0 then 1 else 0 end)::int`,
        replied: sql<number>`sum(case when ${prospectsTable.replied} = 1 then 1 else 0 end)::int`,
      })
      .from(prospectsTable)
      .where(and(...prospectConds));

    const followupConds = [SCOPE];
    if (userIdFilter) followupConds.push(eq(prospectsTable.userId, userIdFilter));

    const followupStats = await db
      .select({
        queuedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'queued' then 1 else 0 end)::int`,
        sentFollowups: sql<number>`sum(case when ${followupsTable.status} = 'sent' then 1 else 0 end)::int`,
        draftedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'drafted' then 1 else 0 end)::int`,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(...followupConds));

    const ps = prospectStats[0];
    const fs = followupStats[0];

    res.json({
      total_sent: Number(ps?.totalSent) || 0,
      unreplied: Number(ps?.unreplied) || 0,
      replied: Number(ps?.replied) || 0,
      queued_followups: Number(fs?.queuedFollowups) || 0,
      sent_followups: Number(fs?.sentFollowups) || 0,
      drafted_followups: Number(fs?.draftedFollowups) || 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// GET /context/prospects — list of prospects (mirrors GET /prospects)
// ====================================================================
router.get("/prospects", async (req: Request, res: Response) => {
  try {
    const conds = [SCOPE];
    if (req.query.userId) conds.push(eq(prospectsTable.userId, parseInt(req.query.userId as string)));
    if (req.query.email) conds.push(eq(prospectsTable.email, String(req.query.email)));

    const rows = await db
      .select()
      .from(prospectsTable)
      .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
      .where(and(...conds))
      .orderBy(desc(prospectsTable.sentAt))
      // B7p: limit raised on /context/prospects for parity with doctrine.
      .limit(50000);

    res.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// GET /context/followups — list with prospect data (Pipeline source)
// ====================================================================
// Phase 7e: reshape to match the doctrine /api/followups response shape
// (snake_case keys + original_* fields + max_followups + created_at).
// The Context Pipeline UI consumes the same FollowupRow type as the
// Doctrine Pipeline UI; keeping the wire format identical means the
// UI components don't need to fork on product.
router.get("/followups", async (req: Request, res: Response) => {
  try {
    const conds = [SCOPE];
    if (req.query.userId) conds.push(eq(prospectsTable.userId, parseInt(req.query.userId as string)));
    if (req.query.email)  conds.push(eq(prospectsTable.email, String(req.query.email)));

    const rows = await db
      .select({
        id: followupsTable.id,
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        scheduledAt: followupsTable.scheduledAt,
        generatedBody: followupsTable.generatedBody,
        generatedSubject: followupsTable.generatedSubject,
        sentAt: followupsTable.sentAt,
        gmailMessageId: followupsTable.gmailMessageId,
        errorMessage: followupsTable.errorMessage,
        createdAt: followupsTable.createdAt,
        prospectName: prospectsTable.prospectName,
        company: prospectsTable.company,
        email: prospectsTable.email,
        vertical: prospectsTable.vertical,
        originalSubject: prospectsTable.subject,
        originalBodySummary: prospectsTable.originalBodySummary,
        originalBody: prospectsTable.originalBody,
        originalLanguage: prospectsTable.originalLanguage,
        originalSentAt: prospectsTable.sentAt,
        gmailThreadId: prospectsTable.gmailThreadId,
        followupPaused: prospectsTable.followupPaused,
        replied: prospectsTable.replied,
        userMaxFollowups: usersTable.maxFollowups,
        userFollowupMode: usersTable.followupMode,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
      .where(and(...conds))
      .orderBy(asc(followupsTable.scheduledAt))
      // B7p: limit raised on /context/followups for parity with doctrine.
      .limit(50000);

    const result = rows.map((r) => ({
      id: r.id,
      prospect_id: r.prospectId,
      stage: r.stage,
      status: r.status,
      scheduled_at: r.scheduledAt.toISOString(),
      generated_body: r.generatedBody,
      generated_subject: r.generatedSubject,
      sent_at: r.sentAt?.toISOString() || null,
      gmail_message_id: r.gmailMessageId,
      error_message: r.errorMessage,
      created_at: r.createdAt.toISOString(),
      prospect_name: r.prospectName,
      company: r.company,
      email: r.email,
      vertical: r.vertical,
      original_subject: r.originalSubject,
      original_body_summary: r.originalBodySummary,
      original_body: r.originalBody,
      original_language: r.originalLanguage,
      original_sent_at: r.originalSentAt?.toISOString() || null,
      gmail_thread_id: r.gmailThreadId,
      followup_paused: r.followupPaused,
      replied: r.replied,
      max_followups: r.userMaxFollowups ?? 3,
      followup_mode: r.userFollowupMode ?? "auto_send",
    }));

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/process — trigger the dispatcher (cron also runs this)
// ====================================================================
router.post("/process", async (_req: Request, res: Response) => {
  try {
    const { processDueFollowups } = await import("../services/scheduler");
    const result = await processDueFollowups();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/sync — trigger Gmail sync for all connected users
//   - With { email }: sync only that user via syncEmailsForUser
//   - Without:        sync all connected users via syncEmails
// ====================================================================
router.post("/sync", async (req: Request, res: Response) => {
  try {
    const email = req.body?.email ? String(req.body.email) : undefined;
    let result;
    if (email) {
      const { syncEmailsForUser } = await import("../services/gmailSync");
      result = await syncEmailsForUser(email);
    } else {
      const { syncEmails } = await import("../services/gmailSync");
      result = await syncEmails();
    }

    // Phase 7k: same fix as doctrine /sync — auto-queue F1 follow-ups
    // for newly-synced prospects so they appear in the Pipeline
    // immediately instead of waiting up to 15 minutes for the cron.
    // autoQueueAllCampaigns is product-blind (walks all unreplied
    // non-paused prospects across both products) so calling it from
    // either /sync or /context/sync produces identical correct
    // behavior for whichever product is currently being synced.
    const { autoQueueAllCampaigns } = await import("../services/scheduler");
    let autoQueued = 0;
    try {
      autoQueued = await autoQueueAllCampaigns();
    } catch (err) {
      logger.warn({ err }, "autoQueueAllCampaigns failed during /context/sync; cron will retry on next tick");
    }

    res.json({ ...result, auto_queued: autoQueued });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// Helper: ensure a prospect exists AND belongs to the context app.
// Doctrine prospects are not addressable via /api/context/* routes.
// ====================================================================
async function loadContextProspect(prospectId: number) {
  const rows = await db
    .select()
    .from(prospectsTable)
    .where(and(SCOPE, eq(prospectsTable.id, prospectId)))
    .limit(1);
  return rows[0] || null;
}

// ====================================================================
// POST /context/followup-now/:prospectId — Send Now (single)
// ====================================================================
router.post("/followup-now/:prospectId", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.prospectId as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await loadContextProspect(prospectId);
    if (!prospect) { res.status(404).json({ error: "Context prospect not found" }); return; }
    if (!prospect.userId) { res.status(400).json({ error: "Prospect has no associated user" }); return; }

    const user = await db.select().from(usersTable).where(eq(usersTable.id, prospect.userId)).limit(1);
    if (!user[0]?.googleRefreshToken || !user[0]?.isConnected) {
      res.status(400).json({ error: "User Gmail not connected" }); return;
    }

    const now = new Date();
    const allFollowups = await db
      .select({ stage: followupsTable.stage })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, prospectId));

    let nextStage = allFollowups.length > 0 ? Math.max(...allFollowups.map((f) => f.stage)) + 1 : 1;

    let insertedFollowupId: number | null = null;
    const MAX_ATTEMPTS = 50;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const inserted = await db
        .insert(followupsTable)
        .values({ prospectId, stage: nextStage, status: "queued", scheduledAt: now })
        .onConflictDoNothing()
        .returning({ id: followupsTable.id });
      if (inserted[0]?.id) { insertedFollowupId = inserted[0].id; break; }
      nextStage++;
    }

    if (!insertedFollowupId) {
      res.status(500).json({ error: `Could not reserve a follow-up stage after ${MAX_ATTEMPTS} attempts.` });
      return;
    }

    const { processDueFollowups } = await import("../services/scheduler");
    const result = await processDueFollowups({ followupId: insertedFollowupId, forceSend: true });

    res.json({
      success: true,
      stage_queued: nextStage,
      immediate_result: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/followup/send-bulk — Bulk Send (capped at 25 per B6)
// ====================================================================
router.post("/followup/send-bulk", async (req: Request, res: Response) => {
  const raw = (req.body && (req.body as any).prospectIds) || [];
  const ids = Array.isArray(raw)
    ? raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "prospectIds must be a non-empty array of positive integers" });
    return;
  }
  if (ids.length > 25) {
    res.status(400).json({ error: "Bulk send limited to 25 prospects per call" });
    return;
  }

  const { processDueFollowups } = await import("../services/scheduler");
  const sent: number[] = [];
  const failed: Array<{ prospectId: number; error: string }> = [];

  for (const prospectId of ids) {
    try {
      const prospect = await loadContextProspect(prospectId);
      if (!prospect) { failed.push({ prospectId, error: "context prospect not found" }); continue; }
      if (!prospect.userId) { failed.push({ prospectId, error: "no user" }); continue; }

      const user = await db.select().from(usersTable).where(eq(usersTable.id, prospect.userId)).limit(1);
      if (!user[0]?.googleRefreshToken || !user[0]?.isConnected) {
        failed.push({ prospectId, error: "user Gmail not connected" }); continue;
      }

      const allFollowups = await db
        .select({ stage: followupsTable.stage })
        .from(followupsTable)
        .where(eq(followupsTable.prospectId, prospectId));

      let nextStage = allFollowups.length > 0 ? Math.max(...allFollowups.map((f) => f.stage)) + 1 : 1;

      let insertedFollowupId: number | null = null;
      for (let attempt = 0; attempt < 50; attempt++) {
        const inserted = await db.insert(followupsTable).values({
          prospectId, stage: nextStage, status: "queued", scheduledAt: new Date(),
        }).onConflictDoNothing().returning({ id: followupsTable.id });
        if (inserted[0]?.id) { insertedFollowupId = inserted[0].id; break; }
        nextStage++;
      }

      if (!insertedFollowupId) { failed.push({ prospectId, error: "could not reserve stage" }); continue; }

      const result = await processDueFollowups({ followupId: insertedFollowupId, forceSend: true });
      if (result.sent > 0 || result.drafted > 0) sent.push(prospectId);
      else if (result.failed > 0) failed.push({ prospectId, error: "send failed" });
      else sent.push(prospectId);
    } catch (err) {
      failed.push({ prospectId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  logger.info(
    { app: "context", requested: ids.length, sent: sent.length, failed: failed.length },
    "Context bulk send-now completed",
  );

  res.json({ success: true, total: ids.length, sent: sent.length, failed, sent_prospect_ids: sent });
});

// ====================================================================
// POST /context/followups/:id/approve — for review_in_app mode
// ====================================================================
router.post("/followups/:id/approve", async (req: Request, res: Response) => {
  const followupId = parseInt((req.params.id as string));
  if (isNaN(followupId)) { res.status(400).json({ error: "Invalid followup ID" }); return; }

  try {
    // Verify the followup belongs to a context prospect
    const rows = await db
      .select({
        followupId: followupsTable.id,
        status: followupsTable.status,
        prospectId: followupsTable.prospectId,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(SCOPE, eq(followupsTable.id, followupId)))
      .limit(1);

    if (!rows[0]) { res.status(404).json({ error: "Context follow-up not found" }); return; }
    if (rows[0].status !== "pending_approval") {
      res.status(400).json({ error: `Cannot approve follow-up with status '${rows[0].status}'` }); return;
    }

    // Flip to queued so the next process tick fires it (with budget+window gating from B6).
    await db
      .update(followupsTable)
      .set({ status: "queued", scheduledAt: new Date() })
      .where(eq(followupsTable.id, followupId));

    const { processDueFollowups } = await import("../services/scheduler");
    const result = await processDueFollowups({ followupId, forceSend: true });

    res.json({ success: true, immediate_result: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/followups/:id/reject — for review_in_app mode
// ====================================================================
router.post("/followups/:id/reject", async (req: Request, res: Response) => {
  const followupId = parseInt((req.params.id as string));
  if (isNaN(followupId)) { res.status(400).json({ error: "Invalid followup ID" }); return; }

  try {
    const rows = await db
      .select({
        followupId: followupsTable.id,
        status: followupsTable.status,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(SCOPE, eq(followupsTable.id, followupId)))
      .limit(1);

    if (!rows[0]) { res.status(404).json({ error: "Context follow-up not found" }); return; }

    await db
      .update(followupsTable)
      .set({ status: "cancelled", errorMessage: "Rejected via review-in-app." })
      .where(eq(followupsTable.id, followupId));

    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/prospect/:id/pause — pause campaign for a prospect
// ====================================================================
router.post("/prospect/:id/pause", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.id as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await loadContextProspect(prospectId);
    if (!prospect) { res.status(404).json({ error: "Context prospect not found" }); return; }

    // Phase 7l Gap A: SCOPE in WHERE makes this a single atomic op
    // that cannot affect doctrine prospects even if prospectId resolution
    // were ever bypassed. Defense-in-depth.
    await db.update(prospectsTable).set({ followupPaused: true }).where(and(SCOPE, eq(prospectsTable.id, prospectId)));

    const { cancelActiveFollowupsForProspects } = await import("../services/scheduler");
    const cancelled = await cancelActiveFollowupsForProspects(
      [prospectId],
      "Campaign paused; active follow-up cancelled.",
    );

    res.json({ success: true, paused: 1, cancelled_queued: cancelled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/prospect/:id/resume — resume campaign for a prospect
// ====================================================================
router.post("/prospect/:id/resume", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.id as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await loadContextProspect(prospectId);
    if (!prospect) { res.status(404).json({ error: "Context prospect not found" }); return; }
    if (prospect.replied) { res.status(400).json({ error: "Prospect already replied" }); return; }

    // Phase 7l Gap A: SCOPE-gated UPDATE for the same defense-in-depth reason
    // as /prospect/:id/pause and /prospect/pause-bulk.
    await db.update(prospectsTable).set({ followupPaused: false }).where(and(SCOPE, eq(prospectsTable.id, prospectId)));

    const { requeueStalledDraftForProspect } = await import("../services/scheduler");
    const stalledRequeue = await requeueStalledDraftForProspect(prospectId);

    // Phase 7l Gap B: parity with doctrine /prospect/:id/resume — if a stalled
    // draft was re-queued, that's the queued stage. Otherwise, if no active
    // follow-up exists, immediately compute the next stage and insert it
    // queued. Without this, a resumed context campaign sits idle until the
    // next 15-min autoQueue cron tick (cron does catch up — no data
    // corruption — but the UX lag is real).
    const user = prospect.userId
      ? (await db.select().from(usersTable).where(eq(usersTable.id, prospect.userId)).limit(1))[0]
      : null;
    const maxFollowups = getFollowupCap(user?.maxFollowups);

    const existingFollowups = await db
      .select({ stage: followupsTable.stage, status: followupsTable.status, sentAt: followupsTable.sentAt })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, prospectId));

    const sentRows = existingFollowups.filter((f) => f.status === "sent");
    const sentStages = sentRows.map((f) => f.stage);
    const activeStages = existingFollowups.filter((f) => ["queued", "generating", "pending_approval", "drafted"].includes(f.status));

    let queued_stage: number | null = null;
    if (stalledRequeue.requeued) {
      queued_stage = stalledRequeue.stage;
    } else if (activeStages.length === 0) {
      const nextStage = sentStages.length > 0 ? Math.max(...sentStages) + 1 : 1;
      if (maxFollowups === null || nextStage <= maxFollowups) {
        const userSettings: UserTimingSettings | undefined = user ? {
          stageTiming: user.stageTiming,
          draftStageTiming: user.draftStageTiming,
          sendDays: user.sendDays,
          sendHourStart: user.sendHourStart,
          sendHourEnd: user.sendHourEnd,
        } : undefined;
        const lastSentAt = sentRows.length > 0
          ? sentRows.reduce((a, b) => (a.stage > b.stage ? a : b)).sentAt
          : null;
        const scheduledAt = computeNextStageScheduledAt({
          stage: nextStage,
          initialSentAt: prospect.sentAt,
          lastFollowupSentAt: lastSentAt,
          userSettings,
          mode: user?.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send",
        });

        try {
          await db.insert(followupsTable).values({
            prospectId,
            stage: nextStage,
            scheduledAt,
            status: "queued",
          });
          queued_stage = nextStage;
        } catch {
          // Race against a concurrent insert (autoQueue cron tick + this resume
          // landing within the same window) — uq_followups_prospect_stage will
          // reject the duplicate. Cron's row stands; nothing to do here.
        }
      }
    }

    res.json({
      success: true,
      resumed: 1,
      stalled_requeued: stalledRequeue.requeued,
      stalled_stage: stalledRequeue.stage,
      queued_stage,
      max_followups: maxFollowups ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/prospect/pause-bulk — bulk pause
// ====================================================================
router.post("/prospect/pause-bulk", async (req: Request, res: Response) => {
  const raw = (req.body && (req.body as any).prospectIds) || [];
  const ids = Array.isArray(raw)
    ? raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "prospectIds must be a non-empty array of positive integers" });
    return;
  }

  try {
    // Restrict to context-only prospects.
    const contextOnly = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(and(SCOPE, inArray(prospectsTable.id, ids)));
    const contextIds = contextOnly.map((r) => r.id);

    if (contextIds.length === 0) {
      res.json({ success: true, total: ids.length, paused: 0, cancelled_queued: 0, sent_prospect_ids: [] });
      return;
    }

    // Phase 7l Gap A: contextIds was already SCOPE-filtered by the prior SELECT,
    // so the SCOPE here is genuinely redundant — but it future-proofs against a
    // refactor that swaps contextIds for ids by accident.
    await db.update(prospectsTable).set({ followupPaused: true }).where(and(SCOPE, inArray(prospectsTable.id, contextIds)));

    const { cancelActiveFollowupsForProspects } = await import("../services/scheduler");
    const cancelled = await cancelActiveFollowupsForProspects(contextIds, "Bulk pause from Context UI.");

    res.json({
      success: true,
      total: ids.length,
      paused: contextIds.length,
      cancelled_queued: cancelled,
      sent_prospect_ids: contextIds,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// POST /context/cancel — cancel queued follow-ups for selected prospects
// ====================================================================
// Phase 7e: cancel specific follow-ups by id (single-stage cancellation
// from the Context Pipeline UI). Mirrors the doctrine /cancel contract.
router.post("/cancel-followup", async (req: Request, res: Response) => {
  try {
    const { followup_ids } = req.body;

    if (!Array.isArray(followup_ids) || followup_ids.length === 0) {
      res.status(400).json({ error: "Missing followup_ids" });
      return;
    }

    // Defense-in-depth: only cancel follow-ups whose prospect is app='context'.
    const result = await db
      .update(followupsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          inArray(followupsTable.id, followup_ids),
          eq(followupsTable.status, "queued"),
          inArray(
            followupsTable.prospectId,
            db.select({ id: prospectsTable.id }).from(prospectsTable).where(SCOPE),
          ),
        ),
      );

    res.json({ cancelled: result.rowCount || 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/cancel", async (req: Request, res: Response) => {
  const raw = (req.body && (req.body as any).prospectIds) || [];
  const ids = Array.isArray(raw)
    ? raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "prospectIds must be a non-empty array of positive integers" });
    return;
  }

  try {
    const contextOnly = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(and(SCOPE, inArray(prospectsTable.id, ids)));
    const contextIds = contextOnly.map((r) => r.id);

    if (contextIds.length === 0) {
      res.json({ success: true, cancelled: 0 });
      return;
    }

    const { cancelActiveFollowupsForProspects } = await import("../services/scheduler");
    const cancelled = await cancelActiveFollowupsForProspects(contextIds, "Cancelled via Context UI.");

    res.json({ success: true, cancelled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// GET /context/campaign/status — Activity Log data
// ====================================================================
// Phase 7i: per-product sidebar activity. Mirrors /api/my/activity
// (in routes/doctrine.ts) but gates on app='context'. Same response
// shape (last_sync, queued, next_due) so the dashboard sidebar
// indicator can switch URLs based on which product is active.
router.get("/my/activity", async (req: Request, res: Response) => {
  const userId = req.query.userId ? parseInt(req.query.userId as string) : null;
  if (!userId) { res.json({ last_sync: null, queued: 0, next_due: null }); return; }

  try {
    const latestProspect = await db
      .select({ createdAt: prospectsTable.createdAt })
      .from(prospectsTable)
      .where(and(SCOPE, eq(prospectsTable.userId, userId)))
      .orderBy(desc(prospectsTable.createdAt))
      .limit(1);

    const queuedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        SCOPE,
        eq(prospectsTable.userId, userId),
        eq(followupsTable.status, "queued"),
      ));

    const nextDue = await db
      .select({ scheduledAt: followupsTable.scheduledAt })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        SCOPE,
        eq(prospectsTable.userId, userId),
        eq(followupsTable.status, "queued"),
      ))
      .orderBy(asc(followupsTable.scheduledAt))
      .limit(1);

    res.json({
      last_sync: latestProspect[0]?.createdAt?.toISOString() || null,
      queued: Number(queuedCount[0]?.count) || 0,
      next_due: nextDue[0]?.scheduledAt?.toISOString() || null,
    });
  } catch (err) {
    res.json({ last_sync: null, queued: 0, next_due: null });
  }
});

// Phase 7g: Context Email Inspector backend. Returns sent emails from
// the user's Gmail with hasContextLabel flagging, plus a DB
// cross-reference scoped to app='context'. Mirrors the structure of
// /api/gmail/sent-emails (in routes/email-inspector.ts) but does NOT
// run vertical inference — context prospects don't carry verticals.
router.get("/gmail/sent-emails", async (req: Request, res: Response) => {
  try {
    const { gmail, senderEmail } = await getGmailForRequest(req);
    const maxResults = Math.min(parseInt(req.query.limit as string) || 30, 50);

    // Resolve labels from the user's contextLabel setting (per-user),
    // not from a global env var. If no userId is given or the user has
    // no contextLabel set, fall back to "Context Followuper".
    const userIdForLabels = req.query.userId ? parseInt(req.query.userId as string) : null;
    let contextLabelStr = "Context Followuper";
    if (userIdForLabels) {
      const u = await db
        .select({ contextLabel: usersTable.contextLabel })
        .from(usersTable)
        .where(eq(usersTable.id, userIdForLabels))
        .limit(1);
      if (u.length > 0 && u[0].contextLabel) contextLabelStr = u[0].contextLabel;
    }
    const contextLabels = contextLabelStr.split(",").map((l) => l.trim()).filter(Boolean);

    const allLabelsRes = await gmail.users.labels.list({ userId: "me" });
    const allLabels = allLabelsRes.data.labels || [];
    const labelNameMap: Record<string, string> = {};
    const contextLabelIds: string[] = [];
    for (const label of allLabels) {
      if (label.id && label.name) {
        labelNameMap[label.id] = label.name;
        const nameLower = label.name.toLowerCase();
        if (contextLabels.some((cl) => nameLower === cl.toLowerCase() || nameLower.startsWith(cl.toLowerCase() + "/"))) {
          contextLabelIds.push(label.id);
        }
      }
    }

    let q = "in:sent";
    if (req.query.search) {
      q += ` ${req.query.search}`;
    }

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults,
    });

    const items = listRes.data.messages || [];
    const emails: any[] = [];

    for (const item of items) {
      if (!item.id) continue;
      try {
        const msgRes = await gmail.users.messages.get({
          userId: "me",
          id: item.id,
          format: "full",
        });

        const msg = msgRes.data;
        if (!msg.id || !msg.threadId) continue;

        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

        let body = "";
        const parts = msg.payload?.parts || [];
        if (msg.payload?.mimeType === "text/plain" && msg.payload?.body?.data) {
          body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
        } else {
          for (const part of parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
              body = Buffer.from(part.body.data, "base64").toString("utf-8");
              break;
            }
          }
        }
        if (!body) {
          let htmlBody = "";
          if (msg.payload?.mimeType === "text/html" && msg.payload?.body?.data) {
            htmlBody = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
          } else {
            for (const part of parts) {
              if (part.mimeType === "text/html" && part.body?.data) {
                htmlBody = Buffer.from(part.body.data, "base64").toString("utf-8");
                break;
              }
            }
          }
          if (htmlBody) {
            body = htmlBody
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<\/div>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          }
        }

        const labelIds = msg.labelIds || [];
        const labelNames = labelIds.map((id) => labelNameMap[id] || id);
        const hasContextLabel = labelIds.some((id) => contextLabelIds.includes(id));
        const matchedContextLabels = labelIds
          .filter((id) => contextLabelIds.includes(id))
          .map((id) => labelNameMap[id] || id);

        const to = getHeader("To");
        const subject = getHeader("Subject");
        const from = getHeader("From");
        const date = getHeader("Date");
        const recipientEmail = extractEmail(to);
        const recipientName = extractName(to);
        const timestamp = parseInt(msg.internalDate || "0");

        const isSentByMe = senderEmail ? from.toLowerCase().includes(senderEmail) : false;
        const withinSyncWindow = isWithinSyncWindow(timestamp);

        const wouldBePickedUp = hasContextLabel && isSentByMe && withinSyncWindow;

        const reasons: string[] = [];
        if (!isSentByMe) reasons.push("Not sent by configured sender email");
        if (!hasContextLabel) reasons.push("Missing context label");
        if (!withinSyncWindow) reasons.push("Outside 60-day sync window");

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          from,
          to,
          recipientEmail,
          recipientName,
          subject,
          snippet: msg.snippet || "",
          bodyPreview: body.slice(0, 800).trim(),
          date,
          timestamp,
          labelIds,
          labelNames,
          hasContextLabel,
          matchedContextLabels,
          isSentByMe,
          detection: {
            wouldBePickedUp,
            whyNot: wouldBePickedUp ? [] : reasons,
            // Phase 7g: vertical inference skipped for context — context
            // prospects don't carry verticals. Empty strings keep the UI
            // shape stable.
            vertical: "",
            subVertical: "",
            verticalReason: "",
            withinSyncWindow,
            company: recipientEmail ? (recipientEmail.split("@")[1]?.split(".")[0] || "") : "",
          },
        });
      } catch (err) {
        logger.error({ err, messageId: item.id }, "Context email inspector — failed to fetch message");
      }
    }

    // DB cross-reference. Same query shape as doctrine but gated on
    // app='context' so doctrine prospects don't false-positive.
    const messageIds = emails.map((e) => e.id);
    const threadIds = [...new Set(emails.map((e) => e.threadId).filter(Boolean))];
    const dbByMessageId: Record<string, any> = {};
    const dbByThreadId: Record<string, any> = {};
    if (messageIds.length > 0) {
      const rows = await db
        .select({
          gmailMessageId: prospectsTable.gmailMessageId,
          gmailThreadId: prospectsTable.gmailThreadId,
          id: prospectsTable.id,
          replied: prospectsTable.replied,
        })
        .from(prospectsTable)
        .where(and(SCOPE, inArray(prospectsTable.gmailMessageId, messageIds)));
      for (const row of rows) {
        if (row.gmailMessageId) dbByMessageId[row.gmailMessageId] = row;
      }
    }
    if (threadIds.length > 0) {
      const threadRows = await db
        .select({
          gmailMessageId: prospectsTable.gmailMessageId,
          gmailThreadId: prospectsTable.gmailThreadId,
          id: prospectsTable.id,
          replied: prospectsTable.replied,
        })
        .from(prospectsTable)
        .where(and(SCOPE, inArray(prospectsTable.gmailThreadId, threadIds)));
      for (const row of threadRows) {
        if (row.gmailThreadId && !dbByThreadId[row.gmailThreadId]) {
          dbByThreadId[row.gmailThreadId] = row;
        }
      }
    }

    const enrichedEmails = emails.map((e) => {
      const directMatch = dbByMessageId[e.id];
      const threadMatch = dbByThreadId[e.threadId];
      const dbRecord = directMatch || threadMatch;
      const matchType = directMatch ? "message" : threadMatch ? "thread" : null;
      return {
        ...e,
        inDatabase: !!dbRecord,
        ...(dbRecord ? { dbRecord: { ...dbRecord, matchType } } : {}),
      };
    });

    res.json({
      emails: enrichedEmails,
      meta: {
        total: enrichedEmails.length,
        withContextLabel: enrichedEmails.filter((e) => e.hasContextLabel).length,
        inDatabase: enrichedEmails.filter((e) => e.inDatabase).length,
        wouldBePickedUp: enrichedEmails.filter((e) => e.detection.wouldBePickedUp).length,
        contextLabelIds,
        contextLabels,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Context email inspector error");
    res.status(500).json({ error: msg });
  }
});

// Phase 7f: rich per-user campaign aggregation matching the doctrine
// shape so the Context Activity Log UI clone can consume it without
// any divergence from activity-log.tsx beyond the label-field rename
// (doctrine_label → context_label).
router.get("/campaign/status", async (_req: Request, res: Response) => {
  try {
    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        isConnected: usersTable.isConnected,
        maxFollowups: usersTable.maxFollowups,
        contextLabel: usersTable.contextLabel,
      })
      .from(usersTable)
      .where(eq(usersTable.isConnected, true));

    const userIds = users.map((u) => u.id);

    const campaignBreakdown = userIds.length > 0
      ? await db
          .select({
            userId: prospectsTable.userId,
            batchLabel: prospectsTable.batchLabel,
            total: sql<number>`count(*)`,
            unreplied: sql<number>`count(*) filter (where ${prospectsTable.replied} = 0)`,
            paused: sql<number>`count(*) filter (where ${prospectsTable.replied} = 0 and ${prospectsTable.followupPaused} = true)`,
          })
          .from(prospectsTable)
          .where(and(SCOPE, inArray(prospectsTable.userId!, userIds)))
          .groupBy(prospectsTable.userId, prospectsTable.batchLabel)
      : [];

    const actionableProspects = userIds.length > 0
      ? await db
          .select({
            prospectId: prospectsTable.id,
            userId: prospectsTable.userId,
            batchLabel: prospectsTable.batchLabel,
          })
          .from(prospectsTable)
          .where(
            and(
              SCOPE,
              eq(prospectsTable.replied, 0),
              eq(prospectsTable.followupPaused, false),
              inArray(prospectsTable.userId!, userIds),
            ),
          )
      : [];

    const activeFollowups = actionableProspects.length > 0
      ? await db
          .select({
            prospectId: followupsTable.prospectId,
            stage: followupsTable.stage,
            status: followupsTable.status,
          })
          .from(followupsTable)
          .where(inArray(followupsTable.prospectId, actionableProspects.map((p) => p.prospectId)))
      : [];

    const prospectFollowupState = new Map<number, { maxSentStage: number; hasActive: boolean }>();
    for (const f of activeFollowups) {
      const entry = prospectFollowupState.get(f.prospectId) || { maxSentStage: 0, hasActive: false };
      if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
      if (["queued", "generating", "pending_approval", "drafted"].includes(f.status)) entry.hasActive = true;
      prospectFollowupState.set(f.prospectId, entry);
    }

    const actionableByUser = new Map<number, number>();
    for (const p of actionableProspects) {
      const state = prospectFollowupState.get(p.prospectId);
      if (state?.hasActive) continue;
      const userMaxFollowups = getFollowupCap(users.find((u) => u.id === p.userId)?.maxFollowups);
      const nextStage = (state?.maxSentStage || 0) + 1;
      if (userMaxFollowups !== null && nextStage > userMaxFollowups) continue;
      if (p.userId == null) continue;
      actionableByUser.set(p.userId, (actionableByUser.get(p.userId) || 0) + 1);
    }

    const followupBreakdown = userIds.length > 0
      ? await db
          .select({
            userId: prospectsTable.userId,
            batchLabel: prospectsTable.batchLabel,
            status: followupsTable.status,
            count: sql<number>`count(*)`,
          })
          .from(followupsTable)
          .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
          .where(and(SCOPE, inArray(prospectsTable.userId!, userIds)))
          .groupBy(prospectsTable.userId, prospectsTable.batchLabel, followupsTable.status)
      : [];

    type CampaignStats = {
      total: number;
      unreplied: number;
      paused: number;
      queued: number;
      sent: number;
    };

    const perUserStats = new Map<number, CampaignStats>();
    const addStats = (uid: number | null, src: Partial<CampaignStats>) => {
      if (uid == null) return;
      const cur = perUserStats.get(uid) || { total: 0, unreplied: 0, paused: 0, queued: 0, sent: 0 };
      cur.total += src.total || 0;
      cur.unreplied += src.unreplied || 0;
      cur.paused += src.paused || 0;
      cur.queued += src.queued || 0;
      cur.sent += src.sent || 0;
      perUserStats.set(uid, cur);
    };

    for (const row of campaignBreakdown) {
      addStats(row.userId, {
        total: Number(row.total),
        unreplied: Number(row.unreplied),
        paused: Number(row.paused),
      });
    }

    for (const row of followupBreakdown) {
      if (row.status === "sent") addStats(row.userId, { sent: Number(row.count) });
      if (["queued", "generating"].includes(row.status)) addStats(row.userId, { queued: Number(row.count) });
    }

    const userCampaigns = users.map((u) => {
      const stats = perUserStats.get(u.id) || { total: 0, unreplied: 0, paused: 0, queued: 0, sent: 0 };
      return {
        id: u.id,
        email: u.email,
        name: u.name || u.email.split("@")[0],
        max_followups: u.maxFollowups,
        // Phase 7f: context_label (vs doctrine_label) so the Context UI
        // displays the user's Context Followuper label.
        context_label: u.contextLabel,
        campaigns: [
          {
            label: u.contextLabel,
            ...stats,
            actionable: actionableByUser.get(u.id) || 0,
          },
        ],
      };
    });

    const totalQueued = [...perUserStats.values()].reduce((a, b) => a + b.queued, 0);
    const totalSent = [...perUserStats.values()].reduce((a, b) => a + b.sent, 0);
    const totalUnreplied = [...perUserStats.values()].reduce((a, b) => a + b.unreplied, 0);

    res.json({
      active: totalQueued > 0,
      queued_count: totalQueued,
      sent_count: totalSent,
      unreplied_prospects: totalUnreplied,
      users: userCampaigns,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
