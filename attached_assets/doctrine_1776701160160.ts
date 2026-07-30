import { Router, type Request, type Response, type NextFunction } from "express";
import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { eq, and, or, sql, inArray, desc, asc, not } from "drizzle-orm";
import { syncEmails } from "../services/gmailSync";
import { generateBatchSchedule, generateScheduledTime, getScheduleWindow } from "../services/timingEngine";
import type { UserTimingSettings } from "../services/timingEngine";
import { processDueFollowups } from "../services/scheduler";
// Test mode fully removed — TEST_MODE_LABEL constant is no longer referenced.

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
  const prospect = await db.select({ userId: prospectsTable.userId }).from(prospectsTable).where(eq(prospectsTable.id, prospectId)).limit(1);
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
    .where(inArray(prospectsTable.id, prospectIds));

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

    const prospectConditions = userIdFilter ? eq(prospectsTable.userId, userIdFilter) : undefined;

    const prospectStats = await db
      .select({
        totalSent: sql<number>`count(*)`,
        unreplied: sql<number>`sum(case when ${prospectsTable.replied} = 0 then 1 else 0 end)`,
        replied: sql<number>`sum(case when ${prospectsTable.replied} = 1 then 1 else 0 end)`,
      })
      .from(prospectsTable)
      .where(prospectConditions);

    const followupQuery = userIdFilter
      ? db.select({
          queuedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'queued' then 1 else 0 end)`,
          sentFollowups: sql<number>`sum(case when ${followupsTable.status} = 'sent' then 1 else 0 end)`,
        })
        .from(followupsTable)
        .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
        .where(eq(prospectsTable.userId, userIdFilter))
      : db.select({
          queuedFollowups: sql<number>`sum(case when ${followupsTable.status} = 'queued' then 1 else 0 end)`,
          sentFollowups: sql<number>`sum(case when ${followupsTable.status} = 'sent' then 1 else 0 end)`,
        })
        .from(followupsTable);

    const followupStats = await followupQuery;

    const ps = prospectStats[0];
    const fs = followupStats[0];

    res.json({
      total_sent: Number(ps?.totalSent) || 0,
      unreplied: Number(ps?.unreplied) || 0,
      replied: Number(ps?.replied) || 0,
      queued_followups: Number(fs?.queuedFollowups) || 0,
      sent_followups: Number(fs?.sentFollowups) || 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get("/prospects", async (req: Request, res: Response) => {
  try {
  const conditions: any[] = [];

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
      .where(eq(prospectsTable.gmailThreadId, threadId))
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
  if (!userId) { res.json({ last_sync: null, queued: 0, next_due: null }); return; }

  try {
    const latestProspect = await db
      .select({ createdAt: prospectsTable.createdAt })
      .from(prospectsTable)
      .where(eq(prospectsTable.userId, userId))
      .orderBy(desc(prospectsTable.createdAt))
      .limit(1);

    const queuedCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        eq(prospectsTable.userId, userId),
        eq(followupsTable.status, "queued"),
      ));

    const nextDue = await db
      .select({ scheduledAt: followupsTable.scheduledAt })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
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
        const result = await db
          .insert(followupsTable)
          .values({
            prospectId: pid,
            stage,
            scheduledAt: new Date(scheduledAt),
          })
          .onConflictDoNothing();

        if (result.rowCount && result.rowCount > 0) {
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
      .where(and(...conditions));

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
        const result = await db
          .insert(followupsTable)
          .values({
            prospectId: pid,
            stage,
            scheduledAt: new Date(scheduledAt),
          })
          .onConflictDoNothing();

        if (result.rowCount && result.rowCount > 0) {
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

router.post("/sync", async (_req: Request, res: Response) => {
  try {
    const result = await syncEmails();
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
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
  const prospectId = parseInt(req.params.prospectId);
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospectId)).limit(1);
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
    const conditions: any[] = [];

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
        followupPaused: prospectsTable.followupPaused,
        replied: prospectsTable.replied,
        userMaxFollowups: usersTable.maxFollowups,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
      .where(whereClause)
      .orderBy(asc(followupsTable.scheduledAt))
      .limit(500);

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
      followup_paused: r.followupPaused,
      replied: r.replied,
      max_followups: r.userMaxFollowups ?? 3,
    }));

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/followups/:id/approve", async (req: Request, res: Response) => {
  const followupId = parseInt(req.params.id);
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
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(eq(followupsTable.id, followupId), eq(followupsTable.status, "pending_approval")))
      .limit(1);

    if (rows.length === 0) {
      res.status(404).json({ error: "Follow-up not found or not pending approval" });
      return;
    }

    const item = rows[0];
    const { sendFollowupReply, getGmailForUser } = await import("../services/gmailClient");

    let senderEmail = "";
    let senderName = "";
    let gmail = undefined;

    if (item.userId) {
      const users = await db.select().from(usersTable).where(eq(usersTable.id, item.userId)).limit(1);
      if (users[0]?.googleRefreshToken && users[0]?.isConnected) {
        senderEmail = users[0].email;
        senderName = users[0].name || users[0].email.split("@")[0];
        gmail = getGmailForUser({ refreshToken: users[0].googleRefreshToken, email: users[0].email });
      }
    }

    if (!senderEmail) {
      res.status(400).json({ error: "No sender credentials available" });
      return;
    }

    const body = req.body.body || item.generatedBody;
    const subject = req.body.subject || item.generatedSubject;

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

    res.json({ success: true, gmail_message_id: gmailMsgId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/followups/:id/reject", async (req: Request, res: Response) => {
  try {
    const followupId = parseInt(req.params.id);
    if (isNaN(followupId)) { res.status(400).json({ error: "Invalid followup ID" }); return; }

    const result = await db
      .update(followupsTable)
      .set({ status: "cancelled" })
      .where(and(eq(followupsTable.id, followupId), eq(followupsTable.status, "pending_approval")));

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
  const prospectId = parseInt(req.params.id);
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const result = await db
      .update(prospectsTable)
      .set({ followupPaused: true })
      .where(eq(prospectsTable.id, prospectId));

    if (!result.rowCount) {
      res.status(404).json({ error: "Prospect not found" });
      return;
    }

    const cancelledQueued = await db
      .update(followupsTable)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(followupsTable.prospectId, prospectId),
          eq(followupsTable.status, "queued"),
        ),
      );

    res.json({
      success: true,
      paused: true,
      cancelled_queued: cancelledQueued.rowCount || 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.post("/prospect/:id/resume", async (req: Request, res: Response) => {
  const prospectId = parseInt(req.params.id);
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await db.select().from(prospectsTable).where(eq(prospectsTable.id, prospectId)).limit(1);
    if (!prospect[0]) { res.status(404).json({ error: "Prospect not found" }); return; }
    if (prospect[0].replied) { res.status(400).json({ error: "Prospect already replied" }); return; }

    await db
      .update(prospectsTable)
      .set({ followupPaused: false })
      .where(eq(prospectsTable.id, prospectId));

    const p = prospect[0];
    const user = p.userId
      ? (await db.select().from(usersTable).where(eq(usersTable.id, p.userId)).limit(1))[0]
      : null;
    const maxFollowups = getFollowupCap(user?.maxFollowups);

    const existingFollowups = await db
      .select({ stage: followupsTable.stage, status: followupsTable.status })
      .from(followupsTable)
      .where(eq(followupsTable.prospectId, prospectId));

    const sentStages = existingFollowups.filter((f) => f.status === "sent").map((f) => f.stage);
    const activeStages = existingFollowups.filter((f) => ["queued", "generating", "pending_approval"].includes(f.status));

    let queued_stage: number | null = null;

    if (activeStages.length === 0) {
      const nextStage = sentStages.length > 0 ? Math.max(...sentStages) + 1 : 1;
      if (maxFollowups === null || nextStage <= maxFollowups) {
        const userSettings: UserTimingSettings | undefined = user ? {
          stageTiming: user.stageTiming,
          sendDays: user.sendDays,
          sendHourStart: user.sendHourStart,
          sendHourEnd: user.sendHourEnd,
        } : undefined;
        const window = getScheduleWindow(nextStage, userSettings);
        const scheduledIso = generateScheduledTime(window, p.sentAt);
        let scheduledAt = new Date(scheduledIso);

        if (scheduledAt < new Date()) {
          scheduledAt = new Date(Date.now() + 60 * 60 * 1000);
        }

        try {
          await db.insert(followupsTable).values({
            prospectId,
            stage: nextStage,
            scheduledAt,
            status: "queued",
          });
          queued_stage = nextStage;
        } catch {
        }
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

router.post("/prospect/:id/campaign-type", async (req: Request, res: Response) => {
  const prospectId = parseInt(req.params.id);
  if (isNaN(prospectId)) { res.status(400).json({ error: "Invalid prospect ID" }); return; }

  try {
    const prospect = await db.select({
      id: prospectsTable.id,
      userId: prospectsTable.userId,
      batchLabel: prospectsTable.batchLabel,
    }).from(prospectsTable).where(eq(prospectsTable.id, prospectId)).limit(1);
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
      .where(eq(prospectsTable.id, prospectId));

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
          .where(inArray(prospectsTable.userId!, userIds))
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
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasActive = true;
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
          .where(inArray(prospectsTable.userId!, userIds))
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
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false };
      if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;
    const now = new Date();

    for (const prospect of unrepliedProspects) {
      const info = prospectFollowupMap.get(prospect.id);
      if (info?.hasQueued) continue;

      const userMaxFollowups = getFollowupCap(users.find(u => u.id === prospect.userId)?.maxFollowups);
      const nextStage = (info?.maxSentStage || 0) + 1;
      if (userMaxFollowups !== null && nextStage > userMaxFollowups) continue;

      const userSettings = prospect.userId ? userSettingsMap.get(prospect.userId) : undefined;
      const window = getScheduleWindow(nextStage, userSettings);
      const scheduledIso = generateScheduledTime(window, prospect.sentAt);
      let scheduledAt = new Date(scheduledIso);

      if (scheduledAt < now) {
        scheduledAt = new Date(now.getTime() + 60 * 60 * 1000);
      }

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
      })
      .from(followupsTable)
      .where(inArray(followupsTable.prospectId, prospectIds));

    const prospectFollowupMap = new Map<number, { maxSentStage: number; hasQueued: boolean }>();
    for (const f of existingFollowups) {
      const entry = prospectFollowupMap.get(f.prospectId) || { maxSentStage: 0, hasQueued: false };
      if (f.status === "sent" && f.stage > entry.maxSentStage) entry.maxSentStage = f.stage;
      if (["queued", "generating", "pending_approval"].includes(f.status)) entry.hasQueued = true;
      prospectFollowupMap.set(f.prospectId, entry);
    }

    const userSettingsMap = new Map<number, UserTimingSettings>();
    for (const u of users) {
      userSettingsMap.set(u.id, {
        stageTiming: u.stageTiming,
        sendDays: u.sendDays,
        sendHourStart: u.sendHourStart,
        sendHourEnd: u.sendHourEnd,
      });
    }

    let queued = 0;
    const parsedMaxStage = max_stage ? parseInt(max_stage) : null;
    const now = new Date();

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
      const window = getScheduleWindow(nextStage, userSettings);
      const scheduledIso = generateScheduledTime(window, prospect.sentAt);
      let scheduledAt = new Date(scheduledIso);
      if (scheduledAt < now) {
        scheduledAt = new Date(now.getTime() + 60 * 60 * 1000);
      }

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
        .where(eq(prospectsTable.userId!, targetUserId));

      const prospectIds = userProspects.map((p) => p.id);

      if (prospectIds.length > 0) {
        const cancelledResult = await db
          .update(followupsTable)
          .set({ status: "cancelled" })
          .where(
            and(
              inArray(followupsTable.status, ["queued", "generating"]),
              inArray(followupsTable.prospectId, prospectIds),
            ),
          );
        cancelledCount = cancelledResult.rowCount || 0;
      }
    } else {
      const cancelledResult = await db
        .update(followupsTable)
        .set({ status: "cancelled" })
        .where(
          inArray(followupsTable.status, ["queued", "generating"]),
        );
      cancelledCount = cancelledResult.rowCount || 0;
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
