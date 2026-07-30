// admin-user-kill.ts — Admin Kill: hard-stop one salesperson's entire
// follow-up pipeline in one transactional action.
//
//   POST /api/admin/users/:id/kill   body: { "confirmName": "<exact name>" }
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// Kill targets one user id and acts across all three subproducts (doctrine,
// context, anti-ghosting). A person has one user row, and their prospects
// carry their user id across all three apps, so scoping every write by
// user_id alone reaches every subproduct without filtering on `app`. Legacy
// prospects with a NULL user id belong to no person, so a per-user kill keyed
// on the user id leaves them untouched.
//
// In ONE transaction it does four things, layered to close every path by
// which a follow-up could still go out:
//
//   1. Cancels every active (non-terminal) follow-up for the user. Follow-ups
//      carry prospect_id, not user_id, so we select them through their
//      prospects: cancel follow-ups whose prospect_id is in the set of the
//      user's prospects, restricted to the active statuses the scheduler
//      assigns (queued, generating, pending_approval, drafted). Terminal
//      states (sent, failed, ok, cancelled) and the parked
//      stalled_awaiting_manual_send state are never touched. This stops work
//      already queued. The active-status list is shared with the scheduler
//      (see lib/adminKill.ts) so it stays correct if a status is added later.
//
//   2. Pauses every one of the user's campaigns (prospect rows):
//      followup_paused = true, pause_reason = 'admin_killed', paused_at = now.
//      This blocks RE-QUEUE, because autoQueueAllCampaigns only selects
//      prospects where followup_paused = false.
//
//   3. Sets the user's paused_by_admin = true. This is the backstop at
//      DISPATCH time: processDueFollowups skips a user whose cached record
//      carries pausedByAdmin, even if a single row ever slipped past the
//      campaign gate.
//
//   4. Returns a summary with counts (follow-ups cancelled, campaigns paused)
//      broken out per subproduct.
//
// The three writes close the queue path (step 1), the re-queue path (step 2),
// and the dispatch path (step 3). Kill NEVER deletes a record and NEVER
// changes `replied`, sent history, or `archived` state.
//
// Reversibility: Kill keeps records, so it is recoverable by hand, but it is
// NOT a one-click undo. The existing per-user resume clears paused_by_admin
// but does NOT un-cancel the cancelled follow-ups and does NOT clear the
// per-campaign followup_paused. There is intentionally no auto-un-kill here.

import { Router, type Request, type Response } from "express";
import { db, usersTable, prospectsTable, followupsTable, type ProspectApp } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  KILL_ACTIVE_FOLLOWUP_STATUSES,
  KILL_CANCEL_MESSAGE,
  KILL_PAUSE_REASON,
  KILL_APPS,
  checkNameMatch,
  buildKillSummary,
} from "../lib/adminKill";

import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

router.post("/admin/users/:id/kill", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const id = parseInt((req.params.id as string), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid user id" }); return; }

    // Look up the target user. Needed for the name-match guard and to 404
    // cleanly when the id does not exist.
    const found = await db
      .select({ id: usersTable.id, email: usersTable.email, name: usersTable.name })
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    if (found.length === 0) { res.status(404).json({ error: `User #${id} not found` }); return; }
    const user = found[0];

    // Name-match guard. A Kill must refuse to act unless the caller typed the
    // exact display name of the target user. An empty stored name or an
    // empty/whitespace confirmName is always a rejection — an empty match
    // would defeat the guard and let a kill fire against the wrong person.
    const confirmName = (req.body && typeof req.body === "object")
      ? (req.body as Record<string, unknown>).confirmName
      : undefined;
    const guard = checkNameMatch(user.name, confirmName);
    if (!guard.ok) {
      const message =
        guard.reason === "stored_name_empty"
          ? `User #${id} has no stored name, so this person cannot be killed until a name is set.`
          : guard.reason === "confirm_name_empty"
            ? "confirmName is required: type the user's exact display name to confirm."
            : "confirmName does not match the user's name. Kill refused.";
      res.status(400).json({ error: message });
      return;
    }

    // All writes run in one transaction so a partial kill cannot occur. If
    // any write throws, the whole action rolls back and the catch below
    // returns 500.
    const now = new Date();
    const perApp: Array<{ app: ProspectApp; followupsCancelled: number; campaignsPaused: number }> = [];

    await db.transaction(async (tx) => {
      for (const app of KILL_APPS) {
        // Sub-select: this user's prospects for this subproduct. user_id
        // scopes to the one person; app scopes the count to the subproduct.
        // Legacy NULL-user prospects are excluded by the user_id equality.
        const prospectIdsForApp = tx
          .select({ id: prospectsTable.id })
          .from(prospectsTable)
          .where(and(eq(prospectsTable.userId, id), eq(prospectsTable.app, app)));

        // 1. Cancel the active follow-ups for this subproduct. Only the
        // non-terminal active statuses are touched; terminal and parked
        // states are left exactly as they are.
        const cancelled = await tx
          .update(followupsTable)
          .set({ status: "cancelled", errorMessage: KILL_CANCEL_MESSAGE })
          .where(and(
            inArray(followupsTable.prospectId, prospectIdsForApp),
            inArray(followupsTable.status, [...KILL_ACTIVE_FOLLOWUP_STATUSES]),
          ))
          .returning({ id: followupsTable.id });

        // 2. Pause every campaign (prospect) for this subproduct. This blocks
        // re-queue. We do NOT touch `replied`, sent history, or `archived`.
        const paused = await tx
          .update(prospectsTable)
          .set({ followupPaused: true, pauseReason: KILL_PAUSE_REASON, pausedAt: now })
          .where(and(eq(prospectsTable.userId, id), eq(prospectsTable.app, app)))
          .returning({ id: prospectsTable.id });

        perApp.push({
          app,
          followupsCancelled: cancelled.length,
          campaignsPaused: paused.length,
        });
      }

      // 3. Dispatch-time backstop: skip this user entirely even if a single
      // row ever slips past the campaign gate.
      const updatedUser = await tx
        .update(usersTable)
        .set({ pausedByAdmin: true })
        .where(eq(usersTable.id, id))
        .returning({ id: usersTable.id });
      if (updatedUser.length === 0) {
        // The user vanished mid-transaction (concurrent delete). Throwing
        // rolls the whole kill back rather than leaving a partial state.
        throw new Error(`User #${id} disappeared during kill`);
      }
    });

    // 4. Per-subproduct + total counts.
    const summary = buildKillSummary(perApp);

    // Log the action (no LLM calls here, so token use and cost are zero).
    logger.info(
      {
        action: "admin_kill",
        userId: id,
        email: user.email,
        followups_cancelled: summary.followups_cancelled,
        campaigns_paused: summary.campaigns_paused,
        by_app: summary.by_app,
        durationMs: Date.now() - startedAt,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      "Admin Kill: pipeline hard-stopped",
    );

    res.json({
      killed: true,
      user: { id: user.id, email: user.email, name: user.name },
      ...summary,
    });
  } catch (err) {
    logger.error({ err }, "Admin Kill failed; transaction rolled back");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to kill user pipeline" });
  }
});

export default router;