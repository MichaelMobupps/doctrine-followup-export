import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { google, gmail_v1 } from "googleapis";
import { db, prospectsTable, followupsTable, usersTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getGmailForUser } from "../services/gmailClient";
import { logger } from "../lib/logger";
// B9c.1a: parseGmailThread for surfacing thread structure to the inspector.
import { validateThreadForMarking, parseGmailThread } from "../services/antiGhostingValidators";
import { classifyDirection } from "../services/threadReader";
import {
  ingestAntiGhostingThread,
  resolveAntiGhostingLabelIds,
  getAlreadyMarkedThreadIds,
} from "../services/antiGhostingIngest";

/**
 * B9b: AntiGhosting Followuper routes.
 *
 * Mounted under /api/anti-ghosting/*. The third product alongside
 * Doctrine and Context. Scoped to prospects with app='anti_ghosting'.
 *
 * Endpoints:
 *
 *   POST /api/anti-ghosting/mark
 *     Body: { email, gmailThreadId, seedMessageId? }
 *     Manual override / force-ingest path. As of B9b.4 the primary
 *     ingest happens automatically when gmailSync sees a thread tagged
 *     with the user's AntiGhosting label — labeling IS the operator's
 *     commit point, matching how Doctrine and Context work. This
 *     endpoint stays for two cases the auto path doesn't cover:
 *       1. Force-ingest a newly-labeled thread immediately instead of
 *          waiting for the next sync cycle.
 *       2. Override the validator's auto-detected seed with an explicit
 *          seedMessageId (operator picks a different anchor message).
 *     Response shape preserved verbatim from B9b for backward compat
 *     with the dashboard.
 *
 *   GET /api/anti-ghosting/candidates?email=...
 *     Lists Gmail threads tagged with the user's antiGhostingLabel that
 *     do not yet have an anti_ghosting prospect. Each candidate
 *     includes seed identification (date, subject, snippet,
 *     daysSinceSeed tier flag) and a per-thread validator preview. With
 *     B9b.4 auto-ingest, this list will typically contain only threads
 *     that failed validators on the last sync — successfully validated
 *     threads disappear from the list as soon as they're ingested.
 *
 * Pause / renewal flows and the dashboard pipeline view ship in B9d.
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

// =====================================================================
// Helpers
// =====================================================================

interface ResolvedUser {
  id: number;
  email: string;
  antiGhostingLabel: string;
  gmail: gmail_v1.Gmail;
}

/**
 * Resolve the user from a request, build a Gmail client, and return both.
 * Throws a structured Error with `status` if the user is not found, not
 * connected, or missing credentials — the calling route handler catches
 * and translates to the matching HTTP status.
 */
async function resolveUserFromEmail(email: string): Promise<ResolvedUser> {
  if (!email) {
    const err = new Error("email is required") as Error & { status: number };
    err.status = 400;
    throw err;
  }

  const users = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);

  if (users.length === 0) {
    const err = new Error(`User not found: ${email}`) as Error & { status: number };
    err.status = 404;
    throw err;
  }

  const user = users[0];
  if (!user.googleRefreshToken || !user.isConnected) {
    const err = new Error(`User ${email} is not connected to Gmail`) as Error & { status: number };
    err.status = 409;
    throw err;
  }

  const gmail = getGmailForUser({
    refreshToken: user.googleRefreshToken,
    email: user.email,
    name: user.name ?? undefined,
  });

  return {
    id: user.id,
    email: user.email,
    // Schema default ("AntiGhosting Followuper") covers existing rows that
    // were created before the column gained a value. Treat null defensively.
    antiGhostingLabel: user.antiGhostingLabel ?? "AntiGhosting Followuper",
    gmail,
  };
}

/**
 * Classify a seed message's age into the three tone tiers used by the
 * downstream generator and by the dashboard's candidate cards.
 */
function daysSinceSeedTier(sentAt: Date, now: Date): "lt_30d" | "30d_to_6mo" | "gt_6mo" {
  const diffMs = now.getTime() - sentAt.getTime();
  const days = diffMs / (24 * 60 * 60 * 1000);
  if (days < 30) return "lt_30d";
  if (days < 180) return "30d_to_6mo";
  return "gt_6mo";
}

// =====================================================================
// POST /api/anti-ghosting/mark
// =====================================================================
//
// B9b.4 refactor: the entire ingest pipeline (validators → prospect
// insert → thread sync → F1 schedule) now lives in
// services/antiGhostingIngest.ts and is shared with the gmailSync
// auto-ingest pass. This handler is a thin wrapper that translates the
// service's IngestResult into the existing HTTP response shape so the
// dashboard's existing call site doesn't change.
//
router.post("/mark", async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.body?.email ? String(req.body.email) : "";
    const gmailThreadId = req.body?.gmailThreadId ? String(req.body.gmailThreadId) : "";
    const overrideSeedMessageId = req.body?.seedMessageId
      ? String(req.body.seedMessageId)
      : undefined;

    if (!gmailThreadId) {
      res.status(400).json({ error: "gmailThreadId is required" });
      return;
    }

    const user = await resolveUserFromEmail(email);

    const result = await ingestAntiGhostingThread({
      userId: user.id,
      gmail: user.gmail,
      userEmail: user.email,
      gmailThreadId,
      overrideSeedMessageId,
    });

    // Idempotency — caller marked a thread that the auto-ingest pass
    // already picked up. 409 Conflict + the existing prospectId so the
    // dashboard can navigate there if useful.
    if (result.alreadyMarked) {
      res.status(409).json({
        error: "Thread already marked",
        prospectId: result.prospectId,
      });
      return;
    }

    // Validator rejection or seed-override error. 200 OK with the
    // structured preview, matching the existing dashboard contract.
    if (!result.success) {
      res.json({
        ok: false,
        results: result.validatorResults,
        prospect: result.prospect,
        failureReason: result.reason,
      });
      return;
    }

    // Success — preserve the B9b response shape verbatim.
    res.json({
      ok: true,
      prospectId: result.prospectId,
      scheduledAt: result.scheduledAt?.toISOString(),
      seed: result.seed
        ? {
            gmailMessageId: result.seed.gmailMessageId,
            subject: result.seed.subject,
            sentAt: result.seed.sentAt.toISOString(),
          }
        : undefined,
      prospect: result.prospect,
      results: result.validatorResults,
    });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    const msg = err instanceof Error ? err.message : String(err);
    if (status >= 500) logger.error({ err }, "POST /anti-ghosting/mark failed");
    res.status(status).json({ error: msg });
  }
});

// =====================================================================
// GET /api/anti-ghosting/candidates
// =====================================================================
router.get("/candidates", async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.query.email ? String(req.query.email) : "";
    const maxResults = Math.min(
      parseInt((req.query.limit as string) ?? "20", 10) || 20,
      50,
    );

    const user = await resolveUserFromEmail(email);

    // 1. Resolve antiGhosting label IDs.
    const labelIds = await resolveAntiGhostingLabelIds(user.gmail, user.antiGhostingLabel);
    if (labelIds.length === 0) {
      res.json({
        ok: true,
        candidates: [],
        note: `No Gmail labels matching "${user.antiGhostingLabel}" found in user's mailbox. Apply that label in Gmail to mark threads for re-engagement.`,
      });
      return;
    }

    // 2. List label-tagged threads.
    const threadsRes = await user.gmail.users.threads.list({
      userId: "me",
      labelIds,
      maxResults,
    });
    const threads = threadsRes.data.threads || [];

    // 3. Filter out threads that already have an anti_ghosting prospect.
    //    Direct query on prospectsTable.gmailThreadId via the moved
    //    helper — more correct than B9b's JOIN through thread_messages
    //    (which missed prospects whose thread sync failed).
    const alreadyMarked = await getAlreadyMarkedThreadIds(user.id);

    // 4. For each remaining thread, run validators to populate the preview.
    //    Validators short-circuit on first failure so this is cheap for
    //    most threads (typically 1 Gmail call + 1 DB lookup).
    const now = new Date();
    const candidates: unknown[] = [];
    for (const t of threads) {
      if (!t.id) continue;
      if (alreadyMarked.has(t.id)) continue;

      try {
        const outcome = await validateThreadForMarking(t.id, user.gmail, user.email, user.id);
        candidates.push({
          gmailThreadId: t.id,
          ok: outcome.ok,
          results: outcome.results,
          failureReason: outcome.failureReason,
          prospect: outcome.prospect,
          seed: outcome.seed
            ? {
                gmailMessageId: outcome.seed.id,
                subject: outcome.seed.subject,
                snippet: outcome.seed.snippet,
                sentAt: outcome.seed.sentAt.toISOString(),
                daysSinceSeedTier: daysSinceSeedTier(outcome.seed.sentAt, now),
              }
            : null,
        });
      } catch (err) {
        logger.warn({ err, threadId: t.id }, "validator failed for candidate thread; skipping");
      }
    }

    res.json({ ok: true, candidates });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status ?? 500;
    const msg = err instanceof Error ? err.message : String(err);
    if (status >= 500) logger.error({ err }, "GET /anti-ghosting/candidates failed");
    res.status(status).json({ error: msg });
  }
});

// ====================================================================
// B9b.8.1: GET /api/anti-ghosting/followups
// ====================================================================
// Pipeline data for the dashboard's AntiGhostingPipeline page. Wire
// format identical to /api/context/followups so the same groupByThread
// helper handles both surfaces. Cycle fields are additive.
router.get("/followups", async (req: Request, res: Response) => {
  try {
    const conds = [eq(prospectsTable.app, "anti_ghosting")];
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
        cycle: followupsTable.cycle,
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
        prospectCycle: prospectsTable.cycle,
        userFollowupMode: usersTable.followupMode,
      })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .leftJoin(usersTable, eq(prospectsTable.userId, usersTable.id))
      .where(and(...conds))
      .orderBy(asc(followupsTable.scheduledAt))
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
      cycle: r.cycle,
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
      prospect_cycle: r.prospectCycle,
      max_followups: 3,
      followup_mode: r.userFollowupMode ?? "auto_send",
    }));

    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "GET /anti-ghosting/followups failed");
    res.status(500).json({ error: msg });
  }
});


// ====================================================================
// B9b.9-v2: POST /api/anti-ghosting/prospect/:id/pause
// ====================================================================
// Mirrors context.ts /prospect/:id/pause. Scope-gates every write to
// app='anti_ghosting' for defense-in-depth. Reuses the proven
// cancelActiveFollowupsForProspects helper from services/scheduler
// (app-agnostic; operates on prospect_id).
router.post("/prospect/:id/pause", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid prospect id" });
    return;
  }

  try {
    const [prospect] = await db
      .select()
      .from(prospectsTable)
      .where(and(eq(prospectsTable.id, id), eq(prospectsTable.app, "anti_ghosting")))
      .limit(1);

    if (!prospect) {
      res.status(404).json({ error: "anti_ghosting prospect not found" });
      return;
    }

    // Defense-in-depth: app filter in WHERE prevents pausing a
    // context/doctrine prospect even if id resolution were bypassed.
    await db.update(prospectsTable)
      .set({ followupPaused: true })
      .where(and(eq(prospectsTable.app, "anti_ghosting"), eq(prospectsTable.id, id)));

    const { cancelActiveFollowupsForProspects } = await import("../services/scheduler");
    const cancelled = await cancelActiveFollowupsForProspects(
      [id],
      "AntiGhosting campaign paused; active follow-up cancelled.",
    );

    logger.info({ prospectId: id, cancelled }, "AG prospect paused");
    res.json({ success: true, paused: 1, cancelled_queued: cancelled });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, prospectId: id }, "POST /anti-ghosting/prospect/:id/pause failed");
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// B9b.9-v2: POST /api/anti-ghosting/prospect/:id/resume
// ====================================================================
// Mirrors context.ts /prospect/:id/resume. Scope-gates writes. Hardcodes
// max=3 (AG business rule, no user-level cap). Includes cycle in INSERT.
// Swallows the UNIQUE collision case (cancelled row from prior pause
// occupying the slot) with a logger.warn — same trade-off context.ts
// accepts: dispatcher cron will pick up the unpaused prospect and retry.
router.post("/prospect/:id/resume", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid prospect id" });
    return;
  }

  try {
    const [prospect] = await db
      .select()
      .from(prospectsTable)
      .where(and(eq(prospectsTable.id, id), eq(prospectsTable.app, "anti_ghosting")))
      .limit(1);

    if (!prospect) {
      res.status(404).json({ error: "anti_ghosting prospect not found" });
      return;
    }
    // B9b.12.4: replied prospects can be resumed for manual re-engagement.
    // The status display still shows "Replied", but a newly-scheduled
    // followup will appear and operator can force-send via the + button.

    await db.update(prospectsTable)
      .set({ followupPaused: false })
      .where(and(eq(prospectsTable.app, "anti_ghosting"), eq(prospectsTable.id, id)));

    const currentCycle = prospect.cycle ?? 1;
    const MAX_AG_STAGES_PER_CYCLE = 3;

    const existingFollowups = await db
      .select({ stage: followupsTable.stage, status: followupsTable.status })
      .from(followupsTable)
      .where(and(
        eq(followupsTable.prospectId, id),
        eq(followupsTable.cycle, currentCycle),
      ));

    const sentStages = existingFollowups.filter(f => f.status === "sent").map(f => f.stage);
    const activeStages = existingFollowups.filter(f =>
      ["queued", "generating", "pending_approval", "drafted"].includes(f.status)
    );

    let queued_stage: number | null = null;

    if (activeStages.length === 0) {
      const nextStage = sentStages.length > 0 ? Math.max(...sentStages) + 1 : 1;

      if (nextStage <= MAX_AG_STAGES_PER_CYCLE) {
        // 7d cadence matches the AG ingest interval (Magnit F1 scheduled
        // at original+7d). Not using computeNextStageScheduledAt because
        // AG has its own timing model independent of the doctrine/context
        // engine; introducing it here would require refactoring.
        const scheduledAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        try {
          await db.insert(followupsTable).values({
            prospectId: id,
            stage: nextStage,
            cycle: currentCycle,
            status: "queued",
            scheduledAt,
          });
          queued_stage = nextStage;
        } catch (insertErr) {
          // UNIQUE collision on (prospect_id, cycle, stage). Typical
          // cause: a cancelled row from a prior pause still occupies
          // the slot. Same swallow pattern context.ts uses; dispatcher
          // cron will reconcile on its next tick.
          logger.warn({ err: insertErr, prospectId: id, nextStage, currentCycle },
            "AG resume INSERT collided with existing row; dispatcher will retry");
        }
      }
    }

    logger.info({ prospectId: id, queued_stage }, "AG prospect resumed");
    res.json({ success: true, resumed: 1, queued_stage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, prospectId: id }, "POST /anti-ghosting/prospect/:id/resume failed");
    res.status(500).json({ error: msg });
  }
});


// ====================================================================
// B9b.10-v2: POST /api/anti-ghosting/followup-now/:id
// ====================================================================
// Queues the next stage in the current cycle for immediate dispatch.
// Uses the same INSERT shape as resume but with scheduledAt = NOW.
//
// Frontend hides this button when paused (operator must explicitly
// resume first). Backend also rejects paused prospects as
// defense-in-depth so a direct curl can't bypass the UI gate.
// B9b.12.3: rewritten to mirror Doctrine's /followup-now exactly.
// Defense-in-depth checks (replied/paused/cycle-complete) removed; the
// + button is the user's explicit override and force-sends regardless.
// Aggressive retry bumps stage on UNIQUE collision so stale cancelled
// rows from prior pauses don't wedge us.
router.post("/followup-now/:id", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid prospect id" });
    return;
  }

  try {
    const [prospect] = await db
      .select()
      .from(prospectsTable)
      .where(and(eq(prospectsTable.id, id), eq(prospectsTable.app, "anti_ghosting")))
      .limit(1);

    if (!prospect) {
      res.status(404).json({ error: "anti_ghosting prospect not found" });
      return;
    }
    if (!prospect.userId) {
      res.status(400).json({ error: "Prospect has no associated user" });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, prospect.userId))
      .limit(1);
    if (!user?.googleRefreshToken || !user?.isConnected) {
      res.status(400).json({ error: "User Gmail not connected" });
      return;
    }

    const currentCycle = prospect.cycle ?? 1;
    const now = new Date();

    const allFollowups = await db
      .select({ stage: followupsTable.stage })
      .from(followupsTable)
      .where(and(
        eq(followupsTable.prospectId, id),
        eq(followupsTable.cycle, currentCycle),
      ));

    let nextStage = allFollowups.length > 0
      ? Math.max(...allFollowups.map(f => f.stage)) + 1
      : 1;

    let insertedFollowupId: number | null = null;
    const MAX_ATTEMPTS = 50;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const inserted = await db
        .insert(followupsTable)
        .values({
          prospectId: id,
          stage: nextStage,
          cycle: currentCycle,
          status: "queued",
          scheduledAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: followupsTable.id });

      if (inserted[0]?.id) {
        insertedFollowupId = inserted[0].id;
        break;
      }
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

    logger.info(
      { prospectId: id, stage: nextStage, sent: result.sent, failed: result.failed },
      "AG followup-now processed",
    );

    res.json({
      success: true,
      queued_stage: nextStage,
      sent: result.sent,
      failed: result.failed,
      message: `F${nextStage} dispatched`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, prospectId: id }, "POST /anti-ghosting/followup-now/:id failed");
    res.status(500).json({ error: msg });
  }
});

// B9b.12.3: bulk send-now mirroring Doctrine's /followup/send-bulk.
// Same 25-prospect cap, same per-row retry logic, same response shape.
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
      const [prospect] = await db
        .select()
        .from(prospectsTable)
        .where(and(eq(prospectsTable.id, prospectId), eq(prospectsTable.app, "anti_ghosting")))
        .limit(1);
      if (!prospect) { failed.push({ prospectId, error: "prospect not found" }); continue; }
      if (!prospect.userId) { failed.push({ prospectId, error: "prospect has no associated user" }); continue; }

      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, prospect.userId))
        .limit(1);
      if (!user?.googleRefreshToken || !user?.isConnected) {
        failed.push({ prospectId, error: "user Gmail not connected" });
        continue;
      }

      const currentCycle = prospect.cycle ?? 1;
      const allFollowups = await db
        .select({ stage: followupsTable.stage })
        .from(followupsTable)
        .where(and(
          eq(followupsTable.prospectId, prospectId),
          eq(followupsTable.cycle, currentCycle),
        ));

      let nextStage = allFollowups.length > 0
        ? Math.max(...allFollowups.map(f => f.stage)) + 1
        : 1;

      let insertedFollowupId: number | null = null;
      const MAX_ATTEMPTS = 50;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const inserted = await db
          .insert(followupsTable)
          .values({
            prospectId,
            stage: nextStage,
            cycle: currentCycle,
            status: "queued",
            scheduledAt: new Date(),
          })
          .onConflictDoNothing()
          .returning({ id: followupsTable.id });

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

  res.json({ sent: sent.length, failed, total: ids.length });
});


// ====================================================================
// B9b.13: GET /api/anti-ghosting/my/activity
// ====================================================================
// Per-product sidebar activity for AntiGhosting. Mirrors
// /api/context/my/activity with scope = prospectsTable.app = "anti_ghosting".
// Same response shape (last_sync, queued, next_due) so the dashboard
// sidebar indicator just switches URLs based on which product is active.
router.get("/my/activity", async (req: Request, res: Response) => {
  const userId = req.query.userId ? parseInt(String(req.query.userId), 10) : null;
  if (!userId) { res.json({ last_sync: null, queued: 0, next_due: null }); return; }
  try {
    const SCOPE = eq(prospectsTable.app, "anti_ghosting");

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


// ====================================================================
// B9b.11: POST /api/anti-ghosting/prospect/pause-bulk
// ====================================================================
// Mirrors /api/context/prospect/pause-bulk with SCOPE=anti_ghosting.
// Restricts the operation to AG prospects, sets followupPaused=true on
// each, and cancels any currently active (queued/generating/drafted)
// follow-ups via the shared scheduler helper.
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
    const SCOPE = eq(prospectsTable.app, "anti_ghosting");

    const eligible = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(and(SCOPE, inArray(prospectsTable.id, ids)));
    const eligibleIds = eligible.map((r) => r.id);

    if (eligibleIds.length === 0) {
      res.json({
        success: true,
        total: ids.length,
        paused: 0,
        cancelled_queued: 0,
        sent_prospect_ids: [],
      });
      return;
    }

    await db
      .update(prospectsTable)
      .set({ followupPaused: true })
      .where(and(SCOPE, inArray(prospectsTable.id, eligibleIds)));

    const { cancelActiveFollowupsForProspects } = await import("../services/scheduler");
    const cancelled = await cancelActiveFollowupsForProspects(
      eligibleIds,
      "Bulk pause from AntiGhosting UI.",
    );

    logger.info(
      { totalRequested: ids.length, paused: eligibleIds.length, cancelled },
      "AG bulk pause completed",
    );

    res.json({
      success: true,
      total: ids.length,
      paused: eligibleIds.length,
      cancelled_queued: cancelled,
      sent_prospect_ids: eligibleIds,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "POST /anti-ghosting/prospect/pause-bulk failed");
    res.status(500).json({ error: msg });
  }
});


// ====================================================================
// B9b.11: POST /api/anti-ghosting/prospect/resume-bulk
// ====================================================================
// No direct context analog. Resumes paused AG prospects in bulk:
//   - Filters to AG + non-replied prospects.
//   - Sets followupPaused=false on those.
//   - For each, computes nextStage from sent stages in the current cycle.
//   - Queues a new follow-up at scheduledAt = NOW + 7d (matching the
//     per-prospect resume cadence in B9b.9 v2).
//   - try/catch around each INSERT swallows UNIQUE collisions
//     (cancelled rows from a prior pause occupying the slot) so the
//     bulk operation doesn't bail on the first conflict.
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
    const SCOPE = eq(prospectsTable.app, "anti_ghosting");
    const MAX_AG_STAGES_PER_CYCLE = 3;
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // Pull candidate prospects (AG-scoped). Filter replied in JS so the
    // query works regardless of whether `replied` is integer (0/1) or
    // boolean in Drizzle's mapping.
    const candidates = await db
      .select({
        id: prospectsTable.id,
        cycle: prospectsTable.cycle,
        replied: prospectsTable.replied,
      })
      .from(prospectsTable)
      .where(and(SCOPE, inArray(prospectsTable.id, ids)));

    // B9b.12.4: replied prospects can be resumed too (manual re-engagement).
    const eligible = candidates;
    const eligibleIds = eligible.map((p) => p.id);

    if (eligibleIds.length === 0) {
      res.json({
        success: true,
        total: ids.length,
        resumed: 0,
        queued: 0,
        skipped_replied: candidates.length,
      });
      return;
    }

    // Unpause all eligible prospects in one UPDATE.
    await db
      .update(prospectsTable)
      .set({ followupPaused: false })
      .where(and(SCOPE, inArray(prospectsTable.id, eligibleIds)));

    // Per prospect: compute nextStage and queue. Per-prospect
    // try/catch isolates UNIQUE collisions so one bad slot doesn't
    // abort the whole batch.
    let queuedCount = 0;
    let cycleCompleteCount = 0;
    let collisionCount = 0;

    for (const prospect of eligible) {
      const currentCycle = prospect.cycle ?? 1;

      const sentRows = await db
        .select({ stage: followupsTable.stage })
        .from(followupsTable)
        .where(and(
          eq(followupsTable.prospectId, prospect.id),
          eq(followupsTable.cycle, currentCycle),
          eq(followupsTable.status, "sent"),
        ));

      const sentStages = sentRows.map((r) => r.stage);
      const nextStage = sentStages.length > 0 ? Math.max(...sentStages) + 1 : 1;

      if (nextStage > MAX_AG_STAGES_PER_CYCLE) {
        cycleCompleteCount++;
        continue;
      }

      try {
        await db.insert(followupsTable).values({
          prospectId: prospect.id,
          stage: nextStage,
          cycle: currentCycle,
          status: "queued",
          scheduledAt: new Date(Date.now() + SEVEN_DAYS_MS),
        });
        queuedCount++;
      } catch (insertErr) {
        collisionCount++;
        logger.warn(
          { err: insertErr, prospectId: prospect.id, nextStage, currentCycle },
          "AG resume-bulk INSERT collided with existing row",
        );
      }
    }

    logger.info(
      {
        totalRequested: ids.length,
        eligible: eligibleIds.length,
        queued: queuedCount,
        cycleComplete: cycleCompleteCount,
        collisions: collisionCount,
      },
      "AG bulk resume completed",
    );

    res.json({
      success: true,
      total: ids.length,
      resumed: eligibleIds.length,
      queued: queuedCount,
      cycle_complete: cycleCompleteCount,
      collisions: collisionCount,
      skipped_replied: candidates.length - eligibleIds.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "POST /anti-ghosting/prospect/resume-bulk failed");
    res.status(500).json({ error: msg });
  }
});


// ====================================================================
// B9b.12: Email Inspector helpers + handlers
// ====================================================================
// Mirrors the structure of context's /gmail/sent-emails + /sync
// endpoints so the inspector page (cloned from context-inspector.tsx)
// has a near-identical UX. Differences:
//   - SCOPE = prospectsTable.app = "anti_ghosting".
//   - Label resolution uses resolveAntiGhostingLabelIds (already
//     imported above) which does proper Gmail label matching.
//   - wouldBePickedUp drops the 60-day-window gate because
//     ingestAntiGhostingLabeledThreads does not filter by date.

function getLegacyGmail(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

async function getGmailForRequest(req: Request): Promise<{ gmail: gmail_v1.Gmail; senderEmail: string }> {
  const userId = req.query.userId ? parseInt(String(req.query.userId), 10) : null;

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

function extractEmailHeader(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/) || headerValue.match(/([^\s,]+@[^\s,]+)/);
  return match ? match[1].trim() : headerValue.trim();
}

function extractNameHeader(headerValue: string): string {
  const match = headerValue.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  const email = extractEmailHeader(headerValue);
  return email.split("@")[0].replace(/[._-]/g, " ");
}

function isWithinSyncWindow(timestamp: number): boolean {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  return timestamp >= sixtyDaysAgo.getTime();
}

// ====================================================================
// B9b.12: GET /api/anti-ghosting/gmail/sent-emails
// ====================================================================
router.get("/gmail/sent-emails", async (req: Request, res: Response) => {
  try {
    const { gmail, senderEmail } = await getGmailForRequest(req);
    const maxResults = Math.min(parseInt(String(req.query.limit), 10) || 30, 50);

    // Build labelNameMap from the user's full label list.
    const allLabelsRes = await gmail.users.labels.list({ userId: "me" });
    const allLabels = allLabelsRes.data.labels || [];
    const labelNameMap: Record<string, string> = {};
    for (const label of allLabels) {
      if (label.id && label.name) {
        labelNameMap[label.id] = label.name;
      }
    }

    // Resolve AG label IDs using the existing helper. Falls back to
    // empty if no userId or no antiGhostingLabel configured.
    const userIdForLabels = req.query.userId ? parseInt(String(req.query.userId), 10) : null;
    let antiGhostingLabelStr = "";
    // B9b.12.1: also capture user email for the validator call below.
    let userEmailFromDb = "";
    if (userIdForLabels) {
      const u = await db
        .select({
          antiGhostingLabel: usersTable.antiGhostingLabel,
          email: usersTable.email,
        })
        .from(usersTable)
        .where(eq(usersTable.id, userIdForLabels))
        .limit(1);
      if (u.length > 0) {
        if (u[0].antiGhostingLabel) antiGhostingLabelStr = u[0].antiGhostingLabel;
        if (u[0].email) userEmailFromDb = u[0].email;
      }
    }
    const antiGhostingLabelIds = antiGhostingLabelStr
      ? await resolveAntiGhostingLabelIds(gmail, antiGhostingLabelStr)
      : [];
    const antiGhostingLabels = antiGhostingLabelStr.split(",").map((l) => l.trim()).filter(Boolean);

    // B9b.12.2: Gmail labels attach to specific messages within a thread
    // (typically the original or inbound), not every outbound. Per-message
    // checks miss threads where the rendered outbound message doesn't
    // directly carry the label. Mirror the ingest pipeline's
    // threads.list approach for inspector accuracy.
    const agLabeledThreadIds = new Set<string>();
    if (antiGhostingLabelIds.length > 0) {
      try {
        const threadsRes = await gmail.users.threads.list({
          userId: "me",
          labelIds: antiGhostingLabelIds,
          maxResults: 50,
        });
        for (const t of threadsRes.data.threads || []) {
          if (t.id) agLabeledThreadIds.add(t.id);
        }
      } catch (err) {
        logger.warn({ err }, "failed to fetch AG-labeled threads for inspector");
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
        // B9b.12.2: thread-level check (see comment above the threads.list call).
        const hasAntiGhostingLabel = msg.threadId ? agLabeledThreadIds.has(msg.threadId) : false;
        const matchedAntiGhostingLabels = labelIds
          .filter((id) => antiGhostingLabelIds.includes(id))
          .map((id) => labelNameMap[id] || id);

        const to = getHeader("To");
        const subject = getHeader("Subject");
        const from = getHeader("From");
        const date = getHeader("Date");
        const recipientEmail = extractEmailHeader(to);
        const recipientName = extractNameHeader(to);
        const timestamp = parseInt(msg.internalDate || "0", 10);

        const isSentByMe = senderEmail ? from.toLowerCase().includes(senderEmail) : false;
        const withinSyncWindow = isWithinSyncWindow(timestamp);

        // AG-specific: no 60-day-window gate because the ingest
        // helper picks up labeled threads regardless of age.
        let wouldBePickedUp = hasAntiGhostingLabel && isSentByMe;

        const reasons: string[] = [];
        if (!isSentByMe) reasons.push("Not sent by configured sender email");
        if (!hasAntiGhostingLabel) reasons.push("Missing AntiGhosting label");

        // B9b.12.1: validator gate for AG-labeled threads. The ingest
        // pipeline runs validateThreadForMarking before creating a
        // prospect; surface its rejection reason in the inspector so
        // the user sees WHY a labeled thread isn't getting picked up.
        if (wouldBePickedUp && userIdForLabels && userEmailFromDb) {
          try {
            const outcome = await validateThreadForMarking(msg.threadId, gmail, userEmailFromDb, userIdForLabels);
            if (!outcome.ok) {
              wouldBePickedUp = false;
              reasons.push(outcome.failureReason || "Validator rejected thread");
            }
          } catch (err) {
            logger.warn({ err, threadId: msg.threadId }, "validator threw during inspector — leaving detection unchanged");
          }
        }

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
          hasAntiGhostingLabel,
          matchedAntiGhostingLabels,
          isSentByMe,
          detection: {
            wouldBePickedUp,
            whyNot: wouldBePickedUp ? [] : reasons,
            vertical: "",
            subVertical: "",
            verticalReason: "",
            withinSyncWindow,
            company: recipientEmail ? (recipientEmail.split("@")[1]?.split(".")[0] || "") : "",
          },
        });
      } catch (err) {
        logger.error({ err, messageId: item.id }, "AG email inspector - failed to fetch message");
      }
    }

    // DB cross-reference. Same query shape as context but gated on
    // app='anti_ghosting'.
    const messageIds = emails.map((e) => e.id);
    const threadIds = [...new Set(emails.map((e) => e.threadId).filter(Boolean))];
    const dbByMessageId: Record<string, any> = {};
    const dbByThreadId: Record<string, any> = {};

    const AG_SCOPE = eq(prospectsTable.app, "anti_ghosting");

    if (messageIds.length > 0) {
      const rows = await db
        .select({
          gmailMessageId: prospectsTable.gmailMessageId,
          gmailThreadId: prospectsTable.gmailThreadId,
          id: prospectsTable.id,
          replied: prospectsTable.replied,
        })
        .from(prospectsTable)
        .where(and(AG_SCOPE, inArray(prospectsTable.gmailMessageId, messageIds)));
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
        .where(and(AG_SCOPE, inArray(prospectsTable.gmailThreadId, threadIds)));
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
        withAntiGhostingLabel: enrichedEmails.filter((e) => e.hasAntiGhostingLabel).length,
        inDatabase: enrichedEmails.filter((e) => e.inDatabase).length,
        wouldBePickedUp: enrichedEmails.filter((e) => e.detection.wouldBePickedUp).length,
        antiGhostingLabelIds,
        antiGhostingLabels,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "AG email inspector error");
    res.status(500).json({ error: msg });
  }
});

// ====================================================================
// B9b.12: POST /api/anti-ghosting/sync
// ====================================================================
// Mirrors POST /api/context/sync. Both syncEmailsForUser and
// syncEmails internally call ingestAntiGhostingLabeledThreads so the
// AG-labeled threads get picked up. autoQueueAllCampaigns is
// product-blind and queues F1 for newly-synced prospects across both
// products, which is what we want here too.
// B9c.2: POST /api/anti-ghosting/prospect/:id/set-seed
// Operator override for the AI's context anchor on an AG prospect. Mirrors
// ingestAntiGhostingThread's overrideSeedMessageId validation: target
// message must exist in the same thread AND must be outbound (sent by
// the user). In-flight queued followups are left alone per Q1(a) — the
// cron will pick up the new seed when it generates each body.
router.post("/prospect/:id/set-seed", async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "invalid prospect id" });
    return;
  }
  const newSeed = req.body && typeof req.body.gmailMessageId === "string"
    ? req.body.gmailMessageId
    : null;
  if (!newSeed) {
    res.status(400).json({ error: "missing or invalid gmailMessageId in body" });
    return;
  }

  try {
    const [prospect] = await db
      .select()
      .from(prospectsTable)
      .where(and(eq(prospectsTable.id, id), eq(prospectsTable.app, "anti_ghosting")))
      .limit(1);
    if (!prospect) {
      res.status(404).json({ error: "anti_ghosting prospect not found" });
      return;
    }
    if (!prospect.userId) {
      res.status(400).json({ error: "prospect has no associated user" });
      return;
    }
    if (!prospect.gmailThreadId) {
      res.status(400).json({ error: "prospect has no associated gmail thread" });
      return;
    }
    if (prospect.gmailMessageId === newSeed) {
      // Already the seed — noop, return success.
      res.json({ success: true, newSeedMessageId: newSeed, noop: true });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, prospect.userId))
      .limit(1);
    if (!user?.googleRefreshToken || !user?.isConnected) {
      res.status(400).json({ error: "user Gmail not connected" });
      return;
    }
    const gmail = getGmailForUser({
      refreshToken: user.googleRefreshToken,
      email: user.email,
    });

    // Validate: the new seed must live in this thread and be outbound.
    const messages = await parseGmailThread(gmail, prospect.gmailThreadId, user.email);
    const target = messages.find((m) => m.id === newSeed);
    if (!target) {
      res.status(400).json({ error: `gmailMessageId ${newSeed} not found in thread ${prospect.gmailThreadId}` });
      return;
    }
    if (classifyDirection(target.fromHeader, user.email) !== "outbound") {
      res.status(400).json({ error: "seed must be an outbound (sent-by-user) message" });
      return;
    }

    try {
      await db
        .update(prospectsTable)
        .set({ gmailMessageId: newSeed })
        .where(eq(prospectsTable.id, id));
    } catch (updateErr) {
      const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
      // UNIQUE constraint on gmailMessageId is table-wide, so another
      // prospect (any app) holding this id will collide.
      if (msg.toLowerCase().includes("unique") || msg.toLowerCase().includes("duplicate")) {
        logger.warn({ prospectId: id, newSeed, oldSeed: prospect.gmailMessageId },
          "AG set-seed UNIQUE collision");
        res.status(409).json({ error: "This message is already used as the anchor for another prospect" });
        return;
      }
      throw updateErr;
    }

    logger.info(
      { prospectId: id, oldSeed: prospect.gmailMessageId, newSeed },
      "AG seed updated",
    );
    res.json({ success: true, newSeedMessageId: newSeed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, prospectId: id }, "POST /anti-ghosting/prospect/:id/set-seed failed");
    res.status(500).json({ error: msg });
  }
});

// B9c.1a: GET /api/anti-ghosting/thread/:gmailThreadId/messages
// Lists every message in a Gmail thread with direction (inbound/outbound)
// and a `isSeed` flag for the message currently driving F1/F2/F3
// generation. Used by the inspector's expanded view (B9c.1b) to show
// the operator what the AI is reading; B9c.2 will add a write
// endpoint so the operator can change the seed.
router.get("/thread/:gmailThreadId/messages", async (req: Request, res: Response) => {
  const gmailThreadId = String(req.params.gmailThreadId);
  const userId = req.query.userId ? parseInt(String(req.query.userId), 10) : null;
  if (!gmailThreadId) {
    res.status(400).json({ error: "missing gmailThreadId" });
    return;
  }
  if (!userId || !Number.isFinite(userId)) {
    res.status(400).json({ error: "missing or invalid userId" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    if (!user.googleRefreshToken || !user.isConnected) {
      res.status(400).json({ error: "user Gmail not connected" });
      return;
    }

    const gmail = getGmailForUser({
      refreshToken: user.googleRefreshToken,
      email: user.email,
    });

    // Cross-reference an AG prospect for this thread so we know which
    // message is the active seed. Scoped per-user + per-app.
    const [prospect] = await db
      .select({
        id: prospectsTable.id,
        gmailMessageId: prospectsTable.gmailMessageId,
      })
      .from(prospectsTable)
      .where(and(
        eq(prospectsTable.app, "anti_ghosting"),
        eq(prospectsTable.gmailThreadId, gmailThreadId),
        eq(prospectsTable.userId, userId),
      ))
      .limit(1);

    const briefs = await parseGmailThread(gmail, gmailThreadId, user.email);

    const messages = briefs.map((b) => ({
      ...b,
      sentAt: b.sentAt.toISOString(),
      direction: classifyDirection(b.fromHeader, user.email),
      isSeed: prospect ? b.id === prospect.gmailMessageId : false,
    }));

    res.json({
      threadId: gmailThreadId,
      prospect: prospect
        ? { id: prospect.id, currentSeedMessageId: prospect.gmailMessageId }
        : null,
      messages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, gmailThreadId, userId }, "GET /thread/:gmailThreadId/messages failed");
    res.status(500).json({ error: msg });
  }
});

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
    const { autoQueueAllCampaigns } = await import("../services/scheduler");
    let autoQueued = 0;
    try {
      autoQueued = await autoQueueAllCampaigns();
    } catch (err) {
      logger.warn({ err }, "autoQueueAllCampaigns failed during /anti-ghosting/sync; cron will retry on next tick");
    }
    res.json({ ...result, auto_queued: autoQueued });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});


// ====================================================================
// GET /api/anti-ghosting/campaign/status
// ====================================================================
// Per-user activity rollup for the Anti-Ghosting Activity Log, scoped to
// app='anti_ghosting'. Mirrors the Doctrine / Context /campaign/status
// shape so the dashboard page is a near-clone.
//
// Anti-ghosting follows threads even after a reply (re-engagement), so
// `paused` and `actionable` are NOT gated on replied=0 the way the
// Doctrine / Context status is — that matches the scheduler's
// anti_ghosting handling. `unreplied` stays the replied=0 count so the
// page's derived `replied = total - unreplied` reads correctly.
function getFollowupCapAG(maxFollowups?: number | null): number | null {
  return typeof maxFollowups === "number" && maxFollowups > 0 ? maxFollowups : null;
}

router.get("/campaign/status", async (_req: Request, res: Response) => {
  try {
    const SCOPE = eq(prospectsTable.app, "anti_ghosting");

    const users = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        maxFollowups: usersTable.maxFollowups,
        antiGhostingLabel: usersTable.antiGhostingLabel,
      })
      .from(usersTable)
      .where(eq(usersTable.isConnected, true));

    const userIds = users.map((u) => u.id);

    const prospectBreakdown = userIds.length > 0
      ? await db
          .select({
            userId: prospectsTable.userId,
            total: sql<number>`count(*)`,
            unreplied: sql<number>`count(*) filter (where ${prospectsTable.replied} = 0)`,
            paused: sql<number>`count(*) filter (where ${prospectsTable.followupPaused} = true)`,
          })
          .from(prospectsTable)
          .where(and(SCOPE, inArray(prospectsTable.userId!, userIds)))
          .groupBy(prospectsTable.userId)
      : [];

    const actionableProspects = userIds.length > 0
      ? await db
          .select({
            prospectId: prospectsTable.id,
            userId: prospectsTable.userId,
          })
          .from(prospectsTable)
          .where(
            and(
              SCOPE,
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
      const cap = getFollowupCapAG(users.find((u) => u.id === p.userId)?.maxFollowups);
      const nextStage = (state?.maxSentStage || 0) + 1;
      if (cap !== null && nextStage > cap) continue;
      if (p.userId == null) continue;
      actionableByUser.set(p.userId, (actionableByUser.get(p.userId) || 0) + 1);
    }

    const followupBreakdown = userIds.length > 0
      ? await db
          .select({
            userId: prospectsTable.userId,
            status: followupsTable.status,
            count: sql<number>`count(*)`,
          })
          .from(followupsTable)
          .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
          .where(and(SCOPE, inArray(prospectsTable.userId!, userIds)))
          .groupBy(prospectsTable.userId, followupsTable.status)
      : [];

    type CampaignStats = { total: number; unreplied: number; paused: number; queued: number; sent: number };
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

    for (const row of prospectBreakdown) {
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
        anti_ghosting_label: u.antiGhostingLabel,
        campaigns: [
          {
            label: u.antiGhostingLabel,
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
    logger.error({ err }, "GET /anti-ghosting/campaign/status failed");
    res.status(500).json({ error: msg });
  }
});


export default router;
