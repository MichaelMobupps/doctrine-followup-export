import { Router, type Request, type Response, type NextFunction } from "express";
import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { eq, and, or, sql, inArray, desc, asc, not } from "drizzle-orm";
import { syncEmails, syncEmailsForUser } from "../services/gmailSync";
import { generateBatchSchedule, generateScheduledTime, getScheduleWindow, computeNextStageScheduledAt } from "../services/timingEngine";
import type { UserTimingSettings } from "../services/timingEngine";
import { cancelActiveFollowupsForProspects, processDueFollowups, queueStageForProspect, requeueStalledDraftForProspect } from "../services/scheduler";
import { logger } from "../lib/logger";
// 2026-07-23: advisory spam-risk check on human-approved sends. The human
// decision is final (no block — a blocked approve would be a dead end for
// rows the scheduler's spam gate diverted here), but the warning is logged
// and returned so the dashboard can surface it.
import { assessSpamRisk, spamGateEnabled } from "../lib/spamRiskLint";
// 2026-07-16 main-screen-hang fix: unbounded-list guard for /followups + /prospects.
import { rejectUnboundedList } from "../lib/listGuards";
// F-3.6b: the send identity. Owner or refusal — there is no env fallback.
import { resolveSendIdentity } from "../lib/ownerIdentity";
// Test mode fully removed — TEST_MODE_LABEL constant is no longer referenced.

// Phase 7c: app-scoping. Every prospect query in this file gates on
// app='doctrine' so the Doctrine UI is isolated from any context
// prospect that exists in the same prospects table.
const SCOPE_DOCTRINE = eq(prospectsTable.app, "doctrine");

const router = Router();

function getFollowupCap(maxFollowups?: number | null): number | null {
  return typeof maxFollowups === "number" && maxFollowups > 0 ? maxFollowups : null;
}

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

async function getUserTimingSettingsForProspect(prospectId: number): Promise<UserTimingSettings | undefined> {
  const prospect = await db.select({ userId: prospectsTable.userId }).from(prospectsTable).where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId))).limit(1);
  if (!prospect[0]?.userId) return undefined;
  const user = await db.select().from(usersTable).where(eq(usersTable.id, prospect[0].userId)).limit(1);
  if (!user[0]) return undefined;
  // Test mode removed — every prospect schedules on its user's production window.
  return {
    stageTiming: user[0].stageTiming,
    sendDays: user[0].sendDays,
    sendHourStart: user[0].sendHourStart,
    sendHourEnd: user[0].sendHourEnd,
  };
}

async function partitionAndSchedule(
  prospectIds: number[],
  stage: number,
): Promise<Map<number, string>> {
  if (prospectIds.length === 0) return new Map();

  // Test mode removed — all prospects schedule on their user's production window.
  // (We keep the function name and signature for caller compatibility.)
  const prospects = await db
    .select({ id: prospectsTable.id, userId: prospectsTable.userId })
    .from(prospectsTable)
    .where(and(SCOPE_DOCTRINE, inArray(prospectsTable.id, prospectIds)));

  const prospectUserMap = new Map<number, number | null>();
  for (const p of prospects) {
    prospectUserMap.set(p.id, p.userId);
  }

  const schedule = new Map<number, string>();

  const userSettingsCache = new Map<number, UserTimingSettings>();
  for (const pid of prospectIds) {
    const uid = prospectUserMap.get(pid);
    if (!uid || userSettingsCache.has(uid)) continue;
    const user = await db.select().from(usersTable).where(eq(usersTable.id, uid)).limit(1);
    if (user[0]) {
      userSettingsCache.set(uid, {
        stageTiming: user[0].stageTiming,
        draftStageTiming: user[0].draftStageTiming,
        sendDays: user[0].sendDays,
        sendHourStart: user[0].sendHourStart,
        sendHourEnd: user[0].sendHourEnd,
      });
    }
  }

  const byUser = new Map<number | null, number[]>();
  for (const pid of prospectIds) {
    const uid = prospectUserMap.get(pid) ?? null;
    const list = byUser.get(uid) || [];
    list.push(pid);
    byUser.set(uid, list);
  }

  for (const [uid, pids] of byUser) {
    const settings = uid ? userSettingsCache.get(uid) : undefined;
    const batch = generateBatchSchedule(pids, stage, settings);
    for (const [pid, time] of batch) schedule.set(pid, time);
  }

  return schedule;
}

router.use(authMiddleware);

router.get("/stats", async (req: Request, res: Response) => {
  try {
    const userIdFilter = req.query.userId ? parseInt(req.query.userId as string) : null;

    // Phase 7c: always scope to doctrine, optionally narrow by user.
    const prospectConditions = userIdFilter
      ? and(SCOPE_DOCTRINE, eq(prospectsTable.userId, userIdFilter))
      : SCOPE_DOCTRINE;

    const prospectStats = await db
      .select({
        totalSent: sql<number>`count(*)`,
        unreplied: sql<number>`sum(case when ${prospectsTable.replied} = 0 then 1 else 0 end)`,
        replied: sql<number>`sum(case when ${prospectsTable.replied} = 1 then 1 else 0 end)`,
      })
      .from(prospectsTable)
      .where(prospectConditions);

    // Phase 7c: followup stats must also scope to doctrine via the prospects join.
    const followupQuery = userIdFilter
      ? db.select({
          queuedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'queued' then 1 else 0 end)`,
          sentFollowups: sql<number>`sum(case when ${followupsTable.status} = 'sent' then 1 else 0 end)`,
          // Phase 7j: drafted_followups added so doctrine /api/stats matches the context shape.
          draftedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'drafted' then 1 else 0 end)`,
        })
        .from(followupsTable)
        .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
        .where(and(SCOPE_DOCTRINE, eq(prospectsTable.userId, userIdFilter)))
      : db.select({
          queuedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'queued' then 1 else 0 end)`,
          sentFollowups: sql<number>`sum(case when ${followupsTable.status} = 'sent' then 1 else 0 end)`,
          // Phase 7j (unfiltered branch): drafted_followups parity with context.
          draftedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'drafted' then 1 else 0 end)`,
        })
        .from(followupsTable)
        .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
        .where(SCOPE_DOCTRINE);

    const followupStats = await followupQuery;

    const ps = prospectStats[0];
    const fs = followupStats[0];

    res.json({
      total_sent: Number(ps?.totalSent) || 0,
      unreplied: Number(ps?.unreplied) || 0,
      replied: Number(ps?.replied) || 0,
      queued_followups: Number(fs?.queuedFollowups) || 0,
      sent_followups: Number(fs?.sentFollowups) || 0,
      // Phase 7j: drafted_followups added for shape parity with /api/context/stats.
      drafted_followups: Number(fs?.draftedFollowups) || 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/prospects", async (req: Request, res: Response) => {
  try {
  // 2026-07-16 main-screen-hang fix: same unbounded-list guard as
  // /followups (this SELECT has no LIMIT at all). The add-on always
  // narrows with replied=0; the dashboard does not call this route.
  if (await rejectUnboundedList(req, res, ["userId", "vertical", "replied"])) return;

  // Phase 7c: scope all returned prospects to the doctrine app.
  const conditions: any[] = [SCOPE_DOCTRINE];

  // Archived campaigns drop out of the active list. ?includeArchived=1 shows them.
  if (req.query.includeArchived !== "1") {
    conditions.push(eq(prospectsTable.archived, false));
  }

  if (req.query.userId) {
    conditions.push(eq(prospectsTable.userId, parseInt(req.query.userId as string)));
  }
  if (req.query.vertical && req.query.vertical !== "all") {
    conditions.push(eq(prospectsTable.vertical, req.query.vertical as string));
  }
  if (req.query.replied !== undefined) {
    conditions.push(eq(prospectsTable.replied, parseInt(req.query.replied as string)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: prospectsTable.id,
      gmailMessageId: prospectsTable.gmailMessageId,
      gmailThreadId: prospectsTable.gmailThreadId,
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
      vertical: prospectsTable.vertical,
      subVertical: prospectsTable.subVertical,
      product: prospectsTable.product,
      subject: prospectsTable.subject,
      originalBodySummary: prospectsTable.originalBodySummary,
      sentAt: prospectsTable.sentAt,
      replied: prospectsTable.replied,
      repliedAt: prospectsTable.repliedAt,
      followupPaused: prospectsTable.followupPaused,
      pauseReason: prospectsTable.pauseReason,
      bounceType: prospectsTable.bounceType,
      archived: prospectsTable.archived,
      createdAt: prospectsTable.createdAt,
      userMaxFollowups: usersTable.maxFollowups,
    })
    .from(prospectsTable)
    .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
    .where(whereClause)
    .orderBy(desc(prospectsTable.sentAt));

  const prospectIds = rows.map((r) => r.id);
  let followupMap: Record<number, Record<number, { status: string; scheduledAt: Date | null; errorMessage: string | null }>> = {};

  if (prospectIds.length > 0) {
    const followups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        scheduledAt: followupsTable.scheduledAt,
        errorMessage: followupsTable.errorMessage,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    for (const f of followups) {
      if (!followupMap[f.prospectId]) followupMap[f.prospectId] = {};
      followupMap[f.prospectId][f.stage] = { status: f.status, scheduledAt: f.scheduledAt, errorMessage: f.errorMessage };
    }
  }

  const verticalLabels: Record<string, string> = {
    gaming_ua: "Gaming UA",
    non_gaming_ua: "Non-Gaming UA",
    cps: "CPS",
    retargeting: "Retargeting",
  };

  const groups: Record<
    string,
    {
      label: string;
      vertical: string;
      sent_date: string;
      prospects: any[];
      total: number;
      unreplied: number;
      replied: number;
    }
  > = {};

  for (const row of rows) {
    const date = row.sentAt.toISOString().split("T")[0];
    const key = `${row.vertical}__${date}`;

    if (!groups[key]) {
      groups[key] = {
        label: `${verticalLabels[row.vertical] || row.vertical} — ${date}`,
        vertical: row.vertical,
        sent_date: date,
        prospects: [],
        total: 0,
        unreplied: 0,
        replied: 0,
      };
    }

    const fu = followupMap[row.id] || {};
    const stageNumbers = Object.keys(fu).map((s) => parseInt(s)).filter((s) => !isNaN(s));
    const maxStage = Math.max(3, ...stageNumbers);
    const followupStatuses: Record<string, string | null> = {};
    for (let s = 1; s <= maxStage; s++) {
      followupStatuses[`followup_${s}_status`] = fu[s]?.status || null;
      followupStatuses[`followup_${s}_scheduled`] = fu[s]?.scheduledAt?.toISOString() || null;
      followupStatuses[`followup_${s}_error`] = fu[s]?.errorMessage || null;
    }
    const prospectData = {
      id: row.id,
      gmail_message_id: row.gmailMessageId,
      gmail_thread_id: row.gmailThreadId,
      prospect_name: row.prospectName,
      company: row.company,
      email: row.email,
      vertical: row.vertical,
      sub_vertical: row.subVertical || null,
      product: row.product,
      subject: row.subject,
      original_body_summary: row.originalBodySummary,
      sent_at: row.sentAt.toISOString(),
      replied: row.replied,
      replied_at: row.repliedAt?.toISOString() || null,
      followup_paused: row.followupPaused,
      pause_reason: row.pauseReason || null,
      bounce_type: row.bounceType || null,
      archived: row.archived,
      max_followups: row.userMaxFollowups ?? 3,
      ...followupStatuses,
    };

    groups[key].prospects.push(prospectData);
    groups[key].total++;
    if (row.replied) groups[key].replied++;
    else groups[key].unreplied++;
  }

  const result = Object.values(groups).sort((a, b) =>
    b.sent_date.localeCompare(a.sent_date),
  );

  res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/prospect/by-thread/:threadId", async (req: Request, res: Response) => {
  try {
    const threadId = String(req.params.threadId);
    const rows = await db
      .select()
      .from(prospectsTable)
      .where(and(SCOPE_DOCTRINE, eq(prospectsTable.gmailThreadId, threadId)))
      .limit(5);

    if (rows.length === 0) {
      res.status(404).json({ error: "Prospect not found for this thread" });
      return;
    }

    const p = rows[0];

    const followups = await db
      .select({
        stage: followupsTable.stage,
        status: followupsTable.status,
        scheduledAt: followupsTable.scheduledAt,
      })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, p.id));

    const fuMap: Record<number, { status: string; scheduledAt: string | null }> = {};
    for (const f of followups) {
      fuMap[f.stage] = { status: f.status, scheduledAt: f.scheduledAt?.toISOString() || null };
    }

    const stageNumbers = Object.keys(fuMap).map((s) => parseInt(s)).filter((s) => !isNaN(s));
    const maxStage = Math.max(3, ...stageNumbers);
    const followupStatuses: Record<string, string | null> = {};
    for (let s = 1; s <= maxStage; s++) {
      followupStatuses[`followup_${s}_status`] = fuMap[s]?.status || null;
      followupStatuses[`followup_${s}_scheduled`] = fuMap[s]?.scheduledAt || null;
    }

    res.json({
      id: p.id,
      gmail_message_id: p.gmailMessageId,
      gmail_thread_id: p.gmailThreadId,
      prospect_name: p.prospectName,
      company: p.company,
      email: p.email,
      vertical: p.vertical,
      sub_vertical: p.subVertical || null,
      product: p.product,
      subject: p.subject,
      original_body_summary: p.originalBodySummary,
      batch_label: p.batchLabel,
      sent_at: p.sentAt.toISOString(),
      replied: p.replied,
      replied_at: p.repliedAt?.toISOString() || null,
      ...followupStatuses,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/my/activity", async (req: Request, res: Response) => {
  const userId = req.query.userId ? parseInt(req.query.userId as string) : null;
  if (!userId) { res.json({ last_sync: null, queued: 0, next_due: null, paused_by_admin: false }); return; }

  try {
    // 2026-07-29 admin-pause visibility: the sidebar polls this endpoint, so
    // it is the one place every page already listens to. An admin-paused
    // account previously showed "All caught up" while auto-queue silently
    // skipped it.
    const userRow = await db
      .select({ pausedByAdmin: usersTable.pausedByAdmin })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const latestProspect = await db
      .select({ createdAt: prospectsTable.createdAt })
      .from(prospectsTable)
      .where(and(SCOPE_DOCTRINE, eq(prospectsTable.userId, userId)))
      .orderBy(desc(prospectsTable.createdAt))
      .limit(1);

    const queuedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        SCOPE_DOCTRINE,
        eq(prospectsTable.userId, userId),
        eq(followupsTable.status, "queued"),
      ));

    const nextDue = await db
      .select({ scheduledAt: followupsTable.scheduledAt })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        SCOPE_DOCTRINE,
        eq(prospectsTable.userId, userId),
        eq(followupsTable.status, "queued"),
      ))
      .orderBy(asc(followupsTable.scheduledAt))
      .limit(1);

    res.json({
      last_sync: latestProspect[0]?.createdAt?.toISOString() || null,
      queued: Number(queuedCount[0]?.count) || 0,
      next_due: nextDue[0]?.scheduledAt?.toISOString() || null,
      paused_by_admin: userRow[0]?.pausedByAdmin ?? false,
    });
  } catch (err) {
    res.json({ last_sync: null, queued: 0, next_due: null, paused_by_admin: false });
  }
});

router.post("/queue", async (req: Request, res: Response) => {
  try {
    const { prospect_ids, stage } = req.body;

    if (!prospect_ids?.length || !stage) {
      res.status(400).json({ error: "Missing prospect_ids or stage" });
      return;
    }

    const schedule = await partitionAndSchedule(prospect_ids, stage);

    let queued = 0;
    let earliest = "";
    let latest = "";

    for (const [pid, scheduledAt] of schedule) {
      try {
        const { queued: didQueue } = await queueStageForProspect(pid, stage, new Date(scheduledAt), { automatic: false });
        if (didQueue) {
          queued++;
          if (!earliest || scheduledAt < earliest) earliest = scheduledAt;
          if (!latest || scheduledAt > latest) latest = scheduledAt;
        }
      } catch {
      }
    }

    res.json({ queued, scheduled_range: { earliest, latest } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/queue-batch", async (req: Request, res: Response) => {
  try {
    const { vertical, sent_date, stage, exclude_ids } = req.body;

    if (!stage) {
      res.status(400).json({ error: "Missing stage" });
      return;
    }

    const conditions: any[] = [eq(prospectsTable.replied, 0)];

    if (vertical && vertical !== "all") {
      conditions.push(eq(prospectsTable.vertical, vertical));
    }
    if (sent_date) {
      conditions.push(sql`date(${prospectsTable.sentAt}) = ${sent_date}`);
    }

    const rows = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(and(SCOPE_DOCTRINE, ...conditions));

    let ids = rows.map((r) => r.id);
    if (exclude_ids?.length) {
      const excludeSet = new Set(exclude_ids as number[]);
      ids = ids.filter((id) => !excludeSet.has(id));
    }

    if (ids.length === 0) {
      res.json({ queued: 0, scheduled_range: { earliest: "", latest: "" } });
      return;
    }

    const schedule = await partitionAndSchedule(ids, stage);

    let queued = 0;
    let earliest = "";
    let latest = "";

    for (const [pid, scheduledAt] of schedule) {
      try {
        const { queued: didQueue } = await queueStageForProspect(pid, stage, new Date(scheduledAt), { automatic: false });
        if (didQueue) {
          queued++;
          if (!earliest || scheduledAt < earliest) earliest = scheduledAt;
          if (!latest || scheduledAt > latest) latest = scheduledAt;
        }
      } catch {
      }
    }

    res.json({ queued, scheduled_range: { earliest, latest } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/sync", async (req: Request, res: Response) => {
  try {
    // When `email` is provided, sync only that user's mailbox. This is the
    // path used by the per-user "Sync Gmail now" button in the add-on, so
    // the clicker doesn't wait for every other tenant's mailbox.
    //
    // When `email` is absent, empty, whitespace, or undefined, fall through
    // to the legacy all-users sync. This preserves the dashboard admin sync
    // and any direct admin tooling that posts to /api/sync without a body.
    // A 400 is returned only when `email` is supplied as a non-string value
    // (caller bug), not when it's missing.
    const rawEmail = req.body?.email;
    if (rawEmail !== undefined && rawEmail !== null && typeof rawEmail !== "string") {
      res.status(400).json({ error: "Invalid 'email' value: must be a string" });
      return;
    }
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";

    let result;
    if (email) {
      logger.info({ email, mode: "per_user" }, "Manual sync requested");
      result = await syncEmailsForUser(email);
    } else {
      logger.info({ mode: "all_users" }, "Manual sync requested");
      result = await syncEmails();
    }

    // Phase 7k: trigger autoQueueAllCampaigns so newly-synced prospects
    // get F1 queued in this request lifecycle. Without this, manual sync
    // creates prospect rows but no follow-up rows until the next 15-min
    // cron tick, leaving the Pipeline empty for synced campaigns. The
    // function is idempotent (uq_followups_prospect_stage +
    // onConflictDoNothing prevent duplicates), so re-running on syncs
    // with 0 new prospects is a cheap no-op.
    const { autoQueueAllCampaigns } = await import("../services/scheduler");
    let autoQueued = 0;
    try {
      autoQueued = await autoQueueAllCampaigns();
    } catch (err) {
      logger.warn({ err }, "autoQueueAllCampaigns failed during /sync; cron will retry on next tick");
    }

    // Explicit shape (not a spread): syncEmails() now also returns an
    // internal perUser diagnostics array (emails + raw error strings) that
    // belongs in cron heartbeats, not in an API response consumed by the
    // add-on and dashboard.
    res.json({ synced: result.synced, repliesDetected: result.repliesDetected, auto_queued: autoQueued });
  } catch (err) {
    const status = (err as any)?.statusCode || 500;
    const msg = err instanceof Error ? err.message : String(err);
    res.status(status).json({ error: msg });
  }
});

router.post("/process", async (_req: Request, res: Response) => {
  try {
    const result = await processDueFollowups();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/followup-now/:prospectId", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.prospectId as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await db.select().from(prospectsTable).where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId))).limit(1);
    if (!prospect[0]) { res.status(404).json({ error: "Prospect not found" }); return; }

    const p = prospect[0];
    if (!p.userId) { res.status(400).json({ error: "Prospect has no associated user" }); return; }

    const user = await db.select().from(usersTable).where(eq(usersTable.id, p.userId)).limit(1);
    if (!user[0]?.googleRefreshToken || !user[0]?.isConnected) {
      res.status(400).json({ error: "User Gmail not connected" }); return;
    }

    const now = new Date();

    // Compute starting stage from ALL existing follow-ups (queued, generating,
    // pending_approval, sent, failed, cancelled) — not just sent. Without this
    // we race any row already sitting on the next stage slot and the insert
    // hits the uq_followups_prospect_stage unique constraint, surfacing as
    // "duplicate key value violates unique constraint" to the UI.
    const allFollowups = await db
      .select({ stage: followupsTable.stage })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, prospectId));

    let nextStage =
      allFollowups.length > 0
        ? Math.max(...allFollowups.map((f) => f.stage)) + 1
        : 1;

    // Aggressive retry loop: on every conflict, bump stage by 1 and try again.
    // No DB re-read needed — if stage N is taken, stage N+1 is our next guess.
    // 50 attempts gives huge headroom (no user will have 50 stages stacked).
    let insertedFollowupId: number | null = null;
    const MAX_ATTEMPTS = 50;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const inserted = await db
        .insert(followupsTable)
        .values({
          prospectId,
          stage: nextStage,
          status: "queued",
          scheduledAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: followupsTable.id });

      if (inserted[0]?.id) {
        insertedFollowupId = inserted[0].id;
        break;
      }

      // Conflict on this stage — bump and retry.
      nextStage++;
    }

    if (!insertedFollowupId) {
      res.status(500).json({
        error: `Could not reserve a follow-up stage after ${MAX_ATTEMPTS} attempts. Please retry.`,
      });
      return;
    }

    const { processDueFollowups } = await import("../services/scheduler");
    const result = await processDueFollowups({ followupId: insertedFollowupId, forceSend: true });

    if (result.failed > 0) {
      res.status(500).json({ error: `Follow-up stage ${nextStage} failed to send.` });
      return;
    }

    if (result.sent === 0) {
      const recheck = await db
        .select({ status: followupsTable.status })
        .from(followupsTable)
        .where(eq(followupsTable.id, insertedFollowupId))
        .limit(1);
      const currentStatus = recheck[0]?.status;
      if (currentStatus === "sent") {
        res.json({
          success: true,
          stage_queued: nextStage,
          immediate_result: { sent: 1, failed: 0 },
          message: `Follow-up stage ${nextStage} sent.`,
        });
        return;
      }
      if (currentStatus === "generating" || currentStatus === "pending_approval") {
        res.json({
          success: true,
          stage_queued: nextStage,
          immediate_result: result,
          message: `Follow-up stage ${nextStage} is being processed (status: ${currentStatus}).`,
        });
        return;
      }
      res.status(500).json({ error: `Follow-up stage ${nextStage} could not be sent (status: ${currentStatus}).` });
      return;
    }

    res.json({
      success: true,
      stage_queued: nextStage,
      immediate_result: result,
      message: `Follow-up stage ${nextStage} sent.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/followups", async (req: Request, res: Response) => {
  try {
    // 2026-07-16 main-screen-hang fix: refuse the fully unfiltered variant
    // on multi-user installs — it returned every user's follow-ups with
    // full email bodies (up to 50k rows) and froze both the requesting tab
    // and, while serializing, the whole server. Dashboard sends userId; the
    // add-on sends status=queued; nothing legitimate sends neither.
    if (await rejectUnboundedList(req, res, ["userId", "status"])) return;

    // Phase 7c: scope to doctrine via the prospects inner-join.
    const conditions: any[] = [SCOPE_DOCTRINE];

    if (req.query.includeArchived !== "1") {
      conditions.push(eq(prospectsTable.archived, false));
    }

    if (req.query.status) {
      conditions.push(eq(followupsTable.status, req.query.status as string));
    }
    if (req.query.userId) {
      conditions.push(eq(prospectsTable.userId, parseInt(req.query.userId as string)));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

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
        pauseReason: prospectsTable.pauseReason,
        bounceType: prospectsTable.bounceType,
        replied: prospectsTable.replied,
        userMaxFollowups: usersTable.maxFollowups,
        userFollowupMode: usersTable.followupMode,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
      .where(whereClause)
      .orderBy(asc(followupsTable.scheduledAt))
      // B7p: limit raised; dashboard truncated for users with 150+ prospects
      // and their queued tail rows fell off the end of the response, which
      // surfaced as "No stages queued" in the Pipeline page even when the
      // database had a queued row for the prospect.
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
      pause_reason: r.pauseReason || null,
      bounce_type: r.bounceType || null,
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

router.post("/followups/:id/approve", async (req: Request, res: Response) => {
  const followupId = parseInt((req.params.id as string));
  if (isNaN(followupId)) { res.status(400).json({ error: "Invalid followup ID" }); return; }

  try {
    const rows = await db
      .select({
        id: followupsTable.id,
        prospectId: followupsTable.prospectId,
        generatedBody: followupsTable.generatedBody,
        generatedSubject: followupsTable.generatedSubject,
        prospectEmail: prospectsTable.email,
        gmailThreadId: prospectsTable.gmailThreadId,
        gmailMessageId: prospectsTable.gmailMessageId,
        userId: prospectsTable.userId,
        originalLanguage: prospectsTable.originalLanguage,
        originalSubject: prospectsTable.subject,
        originalBody: prospectsTable.originalBody,
        originalBodySummary: prospectsTable.originalBodySummary,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(SCOPE_DOCTRINE, eq(followupsTable.id, followupId), eq(followupsTable.status, "pending_approval")))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Follow-up not found or not pending approval" });
      return;
    }

    const item = rows[0];
    const { sendFollowupReply, getGmailForUser } = await import("../services/gmailClient");

    // F-3.6b: the identity is the owner's or there is none. This route never
    // read the env fallback itself, but it passed `gmail: undefined` when it
    // could not resolve an owner, and `sendFollowupReply` fell back to
    // `GOOGLE_REFRESH_TOKEN` — so approving a follow-up on an ownerless
    // prospect delivered it from the shared mailbox. The client is now a
    // required argument, and the refusal says which of the two cases it is.
    const owner = item.userId
      ? (await db.select().from(usersTable).where(eq(usersTable.id, item.userId)).limit(1))[0]
      : null;
    const identity = resolveSendIdentity({ userId: item.userId, owner });

    if (!identity.ok) {
      res.status(400).json({
        error: identity.reason === "owner_missing"
          ? "This prospect has no owning account, so there is no Gmail grant to send from. Assign an owner first."
          : "No sender credentials available",
        reason: identity.reason,
      });
      return;
    }

    const { senderEmail, senderName } = identity;
    const gmail = getGmailForUser({ refreshToken: identity.refreshToken, email: senderEmail });

    const body = req.body.body || item.generatedBody;
    const subject = req.body.subject || item.generatedSubject;

    // 2026-07-23 advisory spam-risk check (warn-only on the human path).
    let spamWarning: string[] | null = null;
    if (spamGateEnabled()) {
      const risk = assessSpamRisk(
        subject || "",
        body || "",
        item.originalLanguage || "en",
        [item.originalSubject, item.originalBody, item.originalBodySummary].join("\n"),
      );
      if (risk.highRisk) {
        spamWarning = risk.issues;
        logger.warn(
          { followupId, score: risk.score, rules: risk.rules },
          "SPAM-GATE (advisory): human-approved follow-up carries spam-risk signals — sending per human decision",
        );
      }
    }

    const gmailMsgId = await sendFollowupReply({
      threadId: item.gmailThreadId,
      originalMessageId: item.gmailMessageId,
      to: item.prospectEmail,
      subject: subject || "",
      body: body || "",
      senderName,
      senderEmail,
      gmail,
    });

    await db
      .update(followupsTable)
      .set({
        status: "sent",
        generatedBody: body,
        generatedSubject: subject,
        sentAt: new Date(),
        gmailMessageId: gmailMsgId,
      })
      .where(eq(followupsTable.id, followupId));

    res.json({ success: true, gmail_message_id: gmailMsgId, ...(spamWarning ? { spam_warning: spamWarning } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/followups/:id/reject", async (req: Request, res: Response) => {
  try {
    const followupId = parseInt((req.params.id as string));
    if (isNaN(followupId)) { res.status(400).json({ error: "Invalid followup ID" }); return; }

    // Phase 7c: gate by prospect.app via sub-select so a context follow-up
    // cannot be cancelled through the doctrine route.
    const result = await db
      .update(followupsTable)
      .set({ status: "cancelled" })
      .where(and(
        eq(followupsTable.id, followupId),
        eq(followupsTable.status, "pending_approval"),
        inArray(
          followupsTable.prospectId,
          db.select({ id: prospectsTable.id }).from(prospectsTable).where(SCOPE_DOCTRINE),
        ),
      ));

    if (!result.rowCount) {
      res.status(404).json({ error: "Follow-up not found or not pending approval" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// ---------- Batch 2: bulk endpoints ----------

router.post("/followup/send-bulk", async (req: Request, res: Response) => {
  const raw = (req.body && (req.body as any).prospectIds) || [];
  const ids = Array.isArray(raw)
    ? raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "prospectIds must be a non-empty array of positive integers" });
    return;
  }
  // Phase 6: lowered from 100 → 25. Bulk Send-Now uses forceSend per row,
  // which bypasses the rate limiter, so the cap here is the only ceiling
  // on burst volume through one mailbox in a single call.
  if (ids.length > 25) {
    res.status(400).json({ error: "Bulk send limited to 25 prospects per call" });
    return;
  }

  const { processDueFollowups } = await import("../services/scheduler");
  const sent: number[] = [];
  const failed: Array<{ prospectId: number; error: string }> = [];

  for (const prospectId of ids) {
    try {
      const prospect = await db.select().from(prospectsTable).where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId))).limit(1);
      if (!prospect[0]) { failed.push({ prospectId, error: "prospect not found" }); continue; }
      const p = prospect[0];
      if (!p.userId) { failed.push({ prospectId, error: "prospect has no associated user" }); continue; }

      const user = await db.select().from(usersTable).where(eq(usersTable.id, p.userId)).limit(1);
      if (!user[0]?.googleRefreshToken || !user[0]?.isConnected) {
        failed.push({ prospectId, error: "user Gmail not connected" }); continue;
      }

      // Reserve next stage slot via insert+conflict-retry, same pattern as
      // /followup-now/:prospectId. Without this we race any row already
      // sitting on the next stage slot and hit uq_followups_prospect_stage.
      const allFollowups = await db
        .select({ stage: followupsTable.stage })
        .from(followupsTable)
        .where(eq(followupsTable.prospectId, prospectId));

      let nextStage = allFollowups.length > 0
        ? Math.max(...allFollowups.map(f => f.stage)) + 1
        : 1;

      let insertedFollowupId: number | null = null;
      const MAX_ATTEMPTS = 50;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const inserted = await db.insert(followupsTable).values({
          prospectId,
          stage: nextStage,
          status: "queued",
          scheduledAt: new Date(),
        }).onConflictDoNothing().returning({ id: followupsTable.id });

        if (inserted[0]?.id) { insertedFollowupId = inserted[0].id; break; }
        nextStage++;
      }

      if (!insertedFollowupId) {
        failed.push({ prospectId, error: "could not reserve a stage after 50 attempts" });
        continue;
      }

      const result = await processDueFollowups({ followupId: insertedFollowupId, forceSend: true });
      if (result.sent > 0) {
        sent.push(prospectId);
      } else if (result.failed > 0) {
        failed.push({ prospectId, error: "send failed in scheduler" });
      } else {
        // Followup got reserved + queued but processDueFollowups didn't act
        // on it (e.g. claimed by another worker). Treat as queued.
        sent.push(prospectId);
      }
    } catch (err) {
      failed.push({
        prospectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info(
    { requested: ids.length, sent: sent.length, failed: failed.length },
    "Bulk send-now completed",
  );

  res.json({
    success: true,
    total: ids.length,
    sent: sent.length,
    failed,
    sent_prospect_ids: sent,
  });
});

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
    const pausedResult = await db
      .update(prospectsTable)
      .set({ followupPaused: true, pauseReason: "manual_intervention", pausedAt: new Date() })
      .where(and(SCOPE_DOCTRINE, inArray(prospectsTable.id, ids)));

    const cancelledCount = await cancelActiveFollowupsForProspects(
      ids,
      "Bulk pause requested; active follow-up cancelled.",
    );

    logger.info(
      { requested: ids.length, paused: pausedResult.rowCount || 0, cancelled: cancelledCount },
      "Bulk pause completed",
    );

    res.json({
      success: true,
      requested: ids.length,
      paused: pausedResult.rowCount || 0,
      cancelled_queued: cancelledCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/cancel", async (req: Request, res: Response) => {
  try {
    const { followup_ids } = req.body;

    if (!followup_ids?.length) {
      res.status(400).json({ error: "Missing followup_ids" });
      return;
    }

    const result = await db
      .update(followupsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          inArray(followupsTable.id, followup_ids),
          eq(followupsTable.status, "queued"),
        ),
      );

    res.json({ cancelled: result.rowCount || 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/prospect/:id/pause", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.id as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const result = await db
      .update(prospectsTable)
      .set({ followupPaused: true, pauseReason: "manual_intervention", pausedAt: new Date() })
      .where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId)));

    if (!result.rowCount) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }

    const cancelledQueued = await cancelActiveFollowupsForProspects(
      [prospectId],
      "Prospect paused; active follow-up cancelled.",
    );

    res.json({
      success: true,
      paused: true,
      cancelled_queued: cancelledQueued,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/prospect/resume-bulk", async (req: Request, res: Response) => {
  const raw = (req.body && (req.body as any).prospectIds) || [];
  const ids = Array.isArray(raw)
    ? raw.map((v: unknown) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];
  if (ids.length === 0) {
    res.status(400).json({ error: "prospectIds must be a non-empty array of positive integers" });
    return;
  }

  try {
    const prospects = await db
      .select()
      .from(prospectsTable)
      .where(and(SCOPE_DOCTRINE, inArray(prospectsTable.id, ids)));

    const eligible = prospects.filter((p) => !p.replied);
    const skipped_replied = prospects.length - eligible.length;
    const not_found = ids.length - prospects.length;

    if (eligible.length === 0) {
      res.json({
        success: true,
        requested: ids.length,
        resumed: 0,
        requeued_stalled: 0,
        queued_new: 0,
        skipped_replied,
        not_found,
      });
      return;
    }

    const eligibleIds = eligible.map((p) => p.id);

    await db
      .update(prospectsTable)
      .set({ followupPaused: false, pausedAt: null })
      .where(and(SCOPE_DOCTRINE, inArray(prospectsTable.id, eligibleIds)));

    const uniqueUserIds = Array.from(
      new Set(eligible.map((p) => p.userId).filter((u): u is number => typeof u === "number" && u > 0)),
    );
    const userMap = new Map<number, typeof usersTable.$inferSelect>();
    if (uniqueUserIds.length > 0) {
      const users = await db.select().from(usersTable).where(inArray(usersTable.id, uniqueUserIds));
      for (const u of users) userMap.set(u.id, u);
    }

    const allFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        sentAt: followupsTable.sentAt,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, eligibleIds));

    const followupsByProspect = new Map<number, typeof allFollowups>();
    for (const f of allFollowups) {
      const arr = followupsByProspect.get(f.prospectId);
      if (arr) arr.push(f);
      else followupsByProspect.set(f.prospectId, [f]);
    }

    let requeued_stalled = 0;
    let queued_new = 0;

    for (const p of eligible) {
      const user = p.userId ? userMap.get(p.userId) : null;
      const maxFollowups = getFollowupCap(user?.maxFollowups);

      const existing = followupsByProspect.get(p.id) || [];
      const sentRows = existing.filter((f) => f.status === "sent");
      const sentStages = sentRows.map((f) => f.stage);
      const activeStages = existing.filter((f) =>
        ["queued", "generating", "pending_approval", "drafted"].includes(f.status),
      );

      const stalledRequeue = await requeueStalledDraftForProspect(p.id);
      if (stalledRequeue.requeued) {
        requeued_stalled++;
        continue;
      }

      if (activeStages.length === 0) {
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
            initialSentAt: p.sentAt,
            lastFollowupSentAt: lastSentAt,
            userSettings,
            mode: user?.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send",
          });

          const { queued: didQueue } = await queueStageForProspect(p.id, nextStage, scheduledAt, { automatic: false });
          if (didQueue) queued_new++;
        }
      }
    }

    logger.info(
      { requested: ids.length, resumed: eligible.length, requeued_stalled, queued_new, skipped_replied, not_found },
      "Bulk resume completed",
    );

    res.json({
      success: true,
      requested: ids.length,
      resumed: eligible.length,
      requeued_stalled,
      queued_new,
      skipped_replied,
      not_found,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/prospect/:id/resume", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.id as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await db.select().from(prospectsTable).where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId))).limit(1);
    if (!prospect[0]) { res.status(404).json({ error: "Prospect not found" }); return; }
    if (prospect[0].replied) { res.status(400).json({ error: "Prospect already replied" }); return; }

    await db
      .update(prospectsTable)
      .set({ followupPaused: false, pausedAt: null })
      .where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId)));

    const p = prospect[0];
    const user = p.userId
      ? (await db.select().from(usersTable).where(eq(usersTable.id, p.userId)).limit(1))[0]
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

    const stalledRequeue = await requeueStalledDraftForProspect(prospectId);
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
          initialSentAt: p.sentAt,
          lastFollowupSentAt: lastSentAt,
          userSettings,
          mode: user?.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send",
        });

        const { queued: didQueue } = await queueStageForProspect(prospectId, nextStage, scheduledAt, { automatic: false });
        if (didQueue) queued_stage = nextStage;
      }
    }

    res.json({
      success: true,
      paused: false,
      queued_stage,
      max_followups: maxFollowups ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// POST /prospect/:id/restore — un-archive a campaign.
// Brings an archived campaign back into the active pipeline view in its
// current paused state, and resets paused_at to now so the 14-day archival
// clock restarts. Does not change followup_paused, pause_reason, or replied:
// the operator uses the existing Resume control to reactivate sending. This
// keeps a bounced or replied campaign from being silently resent on restore.
router.post("/prospect/:id/restore", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.id as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }
  try {
    const result = await db
      .update(prospectsTable)
      .set({ archived: false, archivedAt: null, pausedAt: new Date() })
      .where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId), eq(prospectsTable.archived, true)));
    res.json({ success: true, restored: Boolean(result.rowCount) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/prospect/:id/campaign-type", async (req: Request, res: Response) => {
  const prospectId = parseInt((req.params.id as string));
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await db.select({
      id: prospectsTable.id,
      userId: prospectsTable.userId,
      batchLabel: prospectsTable.batchLabel,
    }).from(prospectsTable).where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId))).limit(1);
    if (!prospect[0]) { res.status(404).json({ error: "Prospect not found" }); return; }

    const user = prospect[0].userId
      ? (await db.select({ doctrineLabel: usersTable.doctrineLabel }).from(usersTable).where(eq(usersTable.id, prospect[0].userId)).limit(1))[0]
      : null;

    const newLabel = user?.doctrineLabel || "Doctrine SDR";
    const oldLabel = prospect[0].batchLabel;

    if (oldLabel === newLabel) {
      res.json({
        success: true,
        message: "Already using the active label",
        batch_label: newLabel,
      });
      return;
    }

    await db
      .update(prospectsTable)
      .set({ batchLabel: newLabel })
      .where(and(SCOPE_DOCTRINE, eq(prospectsTable.id, prospectId)));

    res.json({
      success: true,
      message: "Moved to active label",
      batch_label: newLabel,
      previous_label: oldLabel,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/campaign/status", async (_req: Request, res: Response) => {
  try {
    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        isConnected: usersTable.isConnected,
        maxFollowups: usersTable.maxFollowups,
        doctrineLabel: usersTable.doctrineLabel,
      })
      .from(usersTable)
      .where(eq(usersTable.isConnected, true));

    const userIds = users.map((u) => u.id);

    const key = (uid: number | null, label: string) => `${uid}::${label}`;

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
          .where(and(SCOPE_DOCTRINE, inArray(prospectsTable.userId!, userIds)))
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
              SCOPE_DOCTRINE,
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
          .where(inArray(followupsTable.prospectId, actionableProspects.map(p => p.prospectId)))
      : [];

    const prospectFollowupState = new Map<number, { maxSentStage: number; hasActive: boolean }>();
    for (const f of activeFollowups) {
      const entry = prospectFollowupState.get(f.prospectId) || { maxSentStage: 0, hasActive: false };
      if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
      if (["queued", "generating", "pending_approval", "drafted"].includes(f.status)) entry.hasActive = true;
      prospectFollowupState.set(f.prospectId, entry);
    }

    // Aggregate per-user actionable counts (ignore batch label — test mode removed).
    const actionableByUser = new Map<number, number>();
    for (const p of actionableProspects) {
      const state = prospectFollowupState.get(p.prospectId);
      if (state?.hasActive) continue;
      const userMaxFollowups = getFollowupCap(users.find(u => u.id === p.userId)?.maxFollowups);
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
          .where(and(SCOPE_DOCTRINE, inArray(prospectsTable.userId!, userIds)))
          .groupBy(prospectsTable.userId, prospectsTable.batchLabel, followupsTable.status)
      : [];

    type CampaignStats = {
      total: number;
      unreplied: number;
      paused: number;
      queued: number;
      sent: number;
    };

    // Collapse all batch labels for a user into one per-user bucket.
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
        doctrine_label: u.doctrineLabel,
        campaigns: [
          {
            label: u.doctrineLabel,
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

router.post("/campaign/queue", async (req: Request, res: Response) => {
  const { user_id, campaign_type: requestedType } = req.body;

  try {
    const targetUserId = user_id ? parseInt(user_id) : undefined;
    if (user_id && (!targetUserId || isNaN(targetUserId))) {
      res.status(400).json({ error: "Invalid user_id" });
      return;
    }

    const userConditions: any[] = [eq(usersTable.isConnected, true)];
    if (targetUserId) userConditions.push(eq(usersTable.id, targetUserId));
    const users = await db.select().from(usersTable).where(and(...userConditions));

    if (users.length === 0) {
      res.status(400).json({ error: "No connected users found" });
      return;
    }

    const userIds = users.map((u) => u.id);

    const labelConditions = users.map((u) =>
      and(eq(prospectsTable.userId, u.id), eq(prospectsTable.batchLabel, u.doctrineLabel)),
    );

    const unrepliedProspects = await db
      .select({ id: prospectsTable.id, userId: prospectsTable.userId, sentAt: prospectsTable.sentAt })
      .from(prospectsTable)
      .where(
        and(
          SCOPE_DOCTRINE,
          eq(prospectsTable.replied, 0),
          eq(prospectsTable.followupPaused, false),
          or(...labelConditions),
        ),
      );

    if (unrepliedProspects.length === 0) {
      res.json({ queued: 0, message: "No unreplied prospects found." });
      return;
    }

    const prospectIds = unrepliedProspects.map((p) => p.id);
    const existingFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        sentAt: followupsTable.sentAt,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean; lastSentAt: Date | null }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false, lastSentAt: null };
      if (f.status === "sent" && f.stage > entry.maxSentStage) {
        entry.maxSentStage = f.stage;
        entry.lastSentAt = f.sentAt;
      }
      if (["queued", "generating", "pending_approval", "drafted"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        draftStageTiming: u.draftStageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const userMaxFollowups = getFollowupCap(users.find(u => u.id === prospect.userId)?.maxFollowups);
      const nextStage = (info?.maxSentStage || 0) + 1;
      if (userMaxFollowups !== null && nextStage > userMaxFollowups) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const scheduledAt = computeNextStageScheduledAt({
        stage: nextStage,
        initialSentAt: prospect.sentAt,
        lastFollowupSentAt: info?.lastSentAt ?? null,
        userSettings,
        mode: users.find((u) => u.id === prospect.userId)?.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send",
      });

      try {
        await db.insert(followupsTable).values({
          prospectId: prospect.id,
          stage: nextStage,
          scheduledAt,
        });
        queued++;
      } catch {
      }
    }

    res.json({
      queued,
      message: `Queued ${queued} follow-up${queued !== 1 ? "s" : ""}.`,
      normalized_from: requestedType && requestedType !== "production" ? requestedType : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/campaign/launch", async (req: Request, res: Response) => {
  const { user_id, max_stage } = req.body;

  // Test mode removed — /campaign/launch now queues production-window follow-ups
  // for any connected user's unreplied prospects (same effect as /campaign/queue
  // with campaign_type="production"). Kept as a separate route for API compat.
  try {
    const targetUserId = user_id ? parseInt(user_id) : undefined;
    if (user_id && (!targetUserId || isNaN(targetUserId))) {
      res.status(400).json({ error: "Invalid user_id" });
      return;
    }

    const userConditions: any[] = [eq(usersTable.isConnected, true)];
    if (targetUserId) userConditions.push(eq(usersTable.id, targetUserId));
    const users = await db.select().from(usersTable).where(and(...userConditions));

    if (users.length === 0) {
      res.status(400).json({ error: "No connected users found" });
      return;
    }

    const userIds = users.map((u) => u.id);
    const labelConditions = users.map((u) =>
      and(eq(prospectsTable.userId, u.id), eq(prospectsTable.batchLabel, u.doctrineLabel)),
    );

    const unrepliedProspects = await db
      .select({ id: prospectsTable.id, userId: prospectsTable.userId, sentAt: prospectsTable.sentAt })
      .from(prospectsTable)
      .where(
        and(
          SCOPE_DOCTRINE,
          eq(prospectsTable.replied, 0),
          eq(prospectsTable.followupPaused, false),
          or(...labelConditions),
        ),
      );

    if (unrepliedProspects.length === 0) {
      res.json({ launched: true, queued: 0, message: "No unreplied/unpaused prospects found." });
      return;
    }

    const prospectIds = unrepliedProspects.map((p) => p.id);
    const existingFollowups = await db
      .select({
        prospectId: followupsTable.prospectId,
        stage: followupsTable.stage,
        status: followupsTable.status,
        sentAt: followupsTable.sentAt,
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean; lastSentAt: Date | null }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false, lastSentAt: null };
      if (f.status === "sent" && f.stage > entry.maxSentStage) {
        entry.maxSentStage = f.stage;
        entry.lastSentAt = f.sentAt;
      }
      if (["queued", "generating", "pending_approval", "drafted"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        draftStageTiming: u.draftStageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;
    const parsedMaxStage = max_stage ? parseInt(max_stage) : null;

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const nextStage = (info?.maxSentStage || 0) + 1;
      const configuredCap = getFollowupCap(users.find((u) => u.id === prospect.userId)?.maxFollowups);
      const maxStageLimit = (parsedMaxStage && !isNaN(parsedMaxStage) && parsedMaxStage > 0)
        ? parsedMaxStage
        : configuredCap;
      if (maxStageLimit !== null && nextStage > maxStageLimit) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const scheduledAt = computeNextStageScheduledAt({
        stage: nextStage,
        initialSentAt: prospect.sentAt,
        lastFollowupSentAt: info?.lastSentAt ?? null,
        userSettings,
        mode: users.find((u) => u.id === prospect.userId)?.followupMode === "draft_in_gmail" ? "draft_in_gmail" : "auto_send",
      });

      try {
        await db.insert(followupsTable).values({
          prospectId: prospect.id,
          stage: nextStage,
          scheduledAt,
        });
        queued++;
      } catch {
      }
    }

    res.json({
      launched: true,
      queued,
      message: `Campaign launched: ${queued} follow-up${queued !== 1 ? "s" : ""} queued.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/campaign/stop", async (req: Request, res: Response) => {
  try {
    const { user_id } = req.body || {};
    const targetUserId = user_id ? parseInt(user_id) : undefined;
    if (user_id && (!targetUserId || isNaN(targetUserId))) {
      res.status(400).json({ error: "Invalid user_id" });
      return;
    }

    let cancelledCount = 0;

    if (targetUserId) {
      const userProspects = await db
        .select({ id: prospectsTable.id })
        .from(prospectsTable)
        .where(and(SCOPE_DOCTRINE, eq(prospectsTable.userId!, targetUserId)));

      const prospectIds = userProspects.map((p) => p.id);

      if (prospectIds.length > 0) {
        cancelledCount = await cancelActiveFollowupsForProspects(
          prospectIds,
          "Campaign stop requested; active follow-up cancelled.",
        );
      }
    } else {
      const allProspects = await db
        .select({ id: prospectsTable.id })
        .from(prospectsTable)
        .where(SCOPE_DOCTRINE);
      cancelledCount = await cancelActiveFollowupsForProspects(
        allProspects.map((p) => p.id),
        "Campaign stop requested; active follow-up cancelled.",
      );
    }

    const userLabel = targetUserId ? ` for user ${targetUserId}` : "";
    res.json({
      stopped: true,
      cancelled_count: cancelledCount,
      message: `Campaign stopped${userLabel}: ${cancelledCount} queued follow-ups cancelled.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
