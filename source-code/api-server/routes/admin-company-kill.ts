// admin-company-kill.ts — Company-level Admin Kill: hard-stop EVERY doctrine
// campaign at one company in a single transactional action.
//
//   POST /api/admin/company/kill
//   body: { company: string, confirmCompany: string, userId?: number }
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// This sits between the prospect-level Kill (one campaign) and the user-level
// Kill (one person's whole pipeline). It targets every doctrine prospect whose
// company matches `company`, optionally narrowed to a single salesperson via
// `userId` (the pipeline the admin is viewing). It performs the same two
// layers as the prospect-level Kill, applied across the matched set:
//
//   1. Cancels every active (non-terminal) follow-up for the matched
//      prospects. Only the scheduler's active statuses are touched; terminal
//      and parked states are left exactly as they are. The active-status list
//      is shared with the scheduler and the other Kills (lib/adminKill.ts).
//
//   2. Pauses every matched campaign (prospect row): followup_paused = true,
//      pause_reason = 'admin_killed', paused_at = now. This blocks re-queue,
//      because autoQueueAllCampaigns only selects prospects where
//      followup_paused = false.
//
// Both writes run in one transaction so a partial kill cannot occur. Kill
// NEVER deletes a record and NEVER changes `replied`, sent history, or
// `archived` state. Resuming a campaign later clears the pause but does not
// un-cancel the cancelled follow-ups.
//
// The name-confirm guard: the body must carry { confirmCompany } that matches
// `company` exactly (trimmed). Re-using the user-Kill name-match guard means a
// company kill, like a person kill, refuses to fire unless the operator
// re-states the exact target — important because this is a high-blast-radius
// action that can stop many campaigns at once.

import { Router, type Request, type Response } from "express";
import { db, prospectsTable, followupsTable } from "@workspace/db";
import { eq, and, inArray, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  KILL_ACTIVE_FOLLOWUP_STATUSES,
  KILL_CANCEL_MESSAGE,
  KILL_PAUSE_REASON,
  checkNameMatch,
} from "../lib/adminKill";
import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

// Company kills are scoped to the doctrine app, matching the doctrine
// pipeline UI that triggers them.
const SCOPE_DOCTRINE = eq(prospectsTable.app, "doctrine");

router.post("/admin/company/kill", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const body = (req.body && typeof req.body === "object") ? (req.body as Record<string, unknown>) : {};

    const company = typeof body.company === "string" ? body.company.trim() : "";
    if (company.length === 0) {
      res.status(400).json({ error: "company is required and must be a non-empty string." });
      return;
    }

    // Name-confirm guard (re-used from the user-level Kill). The operator must
    // echo the exact company name. An empty or mismatched confirm is refused.
    const guard = checkNameMatch(company, body.confirmCompany);
    if (!guard.ok) {
      const message =
        guard.reason === "mismatch"
          ? "confirmCompany does not match company. Kill refused."
          : "confirmCompany is required: re-type the company name to confirm the kill.";
      res.status(400).json({ error: message });
      return;
    }

    // Optional userId scope. When present, the kill is narrowed to that one
    // salesperson's campaigns at the company (the pipeline being viewed).
    // When absent, every doctrine campaign at the company is targeted.
    let userId: number | undefined;
    if (body.userId !== undefined && body.userId !== null) {
      const n = Number(body.userId);
      if (!Number.isInteger(n) || n <= 0) {
        res.status(400).json({ error: "userId, when provided, must be a positive integer." });
        return;
      }
      userId = n;
    }

    // Resolve the matching prospect ids up front with one trimmed-company
    // select, optionally narrowed to one salesperson. A company here is a
    // handful of contacts, so the id list is small — and matching the
    // inArray(ids) pattern the per-prospect kill and bulk-pause already use
    // keeps this off any subquery edge cases.
    const matchConds = [SCOPE_DOCTRINE, sql`trim(${prospectsTable.company}) = ${company}`];
    if (userId !== undefined) matchConds.push(eq(prospectsTable.userId, userId));
    const matched = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(and(...matchConds));
    const ids = matched.map((r) => r.id);

    if (ids.length === 0) {
      logger.info(
        { action: "admin_company_kill", company, scopedUserId: userId ?? null, campaigns_matched: 0 },
        "Admin Company Kill: no matching campaigns",
      );
      res.json({
        killed: true,
        company,
        scoped_user_id: userId ?? null,
        campaigns_matched: 0,
        campaigns_paused: 0,
        followups_cancelled: 0,
      });
      return;
    }

    const now = new Date();
    let followupsCancelled = 0;
    let campaignsPaused = 0;

    await db.transaction(async (tx) => {
      // 1. Cancel active follow-ups for every matched prospect.
      const cancelled = await tx
        .update(followupsTable)
        .set({ status: "cancelled", errorMessage: KILL_CANCEL_MESSAGE })
        .where(and(
          inArray(followupsTable.prospectId, ids),
          inArray(followupsTable.status, [...KILL_ACTIVE_FOLLOWUP_STATUSES]),
        ))
        .returning({ id: followupsTable.id });
      followupsCancelled = cancelled.length;

      // 2. Pause every matched campaign. Blocks re-queue. Does NOT touch
      // `replied`, sent history, or `archived`.
      const paused = await tx
        .update(prospectsTable)
        .set({ followupPaused: true, pauseReason: KILL_PAUSE_REASON, pausedAt: now })
        .where(inArray(prospectsTable.id, ids))
        .returning({ id: prospectsTable.id });
      campaignsPaused = paused.length;
    });

    logger.info(
      {
        action: "admin_company_kill",
        company,
        scopedUserId: userId ?? null,
        campaigns_matched: ids.length,
        campaigns_paused: campaignsPaused,
        followups_cancelled: followupsCancelled,
        durationMs: Date.now() - startedAt,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      "Admin Company Kill: campaigns hard-stopped",
    );

    res.json({
      killed: true,
      company,
      scoped_user_id: userId ?? null,
      campaigns_matched: ids.length,
      campaigns_paused: campaignsPaused,
      followups_cancelled: followupsCancelled,
    });
  } catch (err) {
    logger.error({ err }, "Admin Company Kill failed; transaction rolled back");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to kill company campaigns" });
  }
});

export default router;
