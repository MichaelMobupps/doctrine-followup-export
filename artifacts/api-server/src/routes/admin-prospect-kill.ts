// admin-prospect-kill.ts — Prospect-level Admin Kill: hard-stop ONE campaign
// (one prospect) in one transactional action.
//
//   POST /api/admin/prospects/:id/kill   body: { "confirmId": <prospect id> }
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// Prospect-level Kill targets one prospect id and hard-stops just that one
// campaign, one level below the user-level Kill (which kills a person's whole
// pipeline across all three subproducts). It deliberately has TWO layers, not
// three:
//
//   1. Cancels every active (non-terminal) follow-up for this prospect.
//      Follow-ups carry prospect_id directly, so we select by
//      prospect_id = :id restricted to the active statuses the scheduler
//      assigns (queued, generating, pending_approval, drafted). Terminal
//      states (sent, failed, ok, cancelled) and the parked
//      stalled_awaiting_manual_send state are never touched. The active-status
//      list is shared with the scheduler and the user-level Kill
//      (see lib/adminKill.ts) so it stays correct if a status is added later.
//
//   2. Pauses that one campaign (prospect row): followup_paused = true,
//      pause_reason = 'admin_killed', paused_at = now. This blocks RE-QUEUE,
//      because autoQueueAllCampaigns only selects prospects where
//      followup_paused = false.
//
// There is NO third layer. Prospect-level Kill does NOT touch the owning
// user's paused_by_admin — that dispatch backstop belongs only to the
// user-level Kill, because we are killing one campaign, not the person. The
// campaign pause (step 2) closes the re-queue path and the cancelled
// follow-ups (step 1) close the queue path for this one campaign.
//
// Kill NEVER deletes a record and NEVER changes `replied`, sent history, or
// `archived` state.
//
// The id-confirm guard: the body must carry { confirmId: <prospect id> } that
// equals the :id in the path. The campaign confirmation uses the prospect's
// own id, not a name, because a prospect name is not unique, and an id echo
// blocks a kill fired from a stale row against the wrong campaign.

import { Router, type Request, type Response } from "express";
import { db, prospectsTable, followupsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  KILL_ACTIVE_FOLLOWUP_STATUSES,
  KILL_CANCEL_MESSAGE,
  KILL_PAUSE_REASON,
  checkProspectConfirm,
  type ProspectKillSummary,
} from "../lib/adminKill";

import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

router.post("/admin/prospects/:id/kill", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const id = parseInt((req.params.id as string), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid prospect id" }); return; }

    // Look up the target prospect. Needed to 404 cleanly when the id does not
    // exist, and to echo identity back in the response/log.
    const found = await db
      .select({
        id: prospectsTable.id,
        userId: prospectsTable.userId,
        prospectName: prospectsTable.prospectName,
        company: prospectsTable.company,
      })
      .from(prospectsTable)
      .where(eq(prospectsTable.id, id))
      .limit(1);
    if (found.length === 0) { res.status(404).json({ error: `Prospect #${id} not found` }); return; }
    const prospect = found[0];

    // Id-confirm guard. A campaign Kill must refuse to act unless the caller
    // echoes the prospect's own id in the body. This blocks a kill fired from
    // a stale row against the wrong campaign. A name is NOT used here because
    // a prospect name is not unique.
    const confirmId = (req.body && typeof req.body === "object")
      ? (req.body as Record<string, unknown>).confirmId
      : undefined;
    const guard = checkProspectConfirm(id, confirmId);
    if (!guard.ok) {
      const message =
        guard.reason === "mismatch"
          ? "confirmId does not match the prospect id in the path. Kill refused."
          : "confirmId is required: send the prospect's id to confirm the campaign kill.";
      res.status(400).json({ error: message });
      return;
    }

    // Both writes run in one transaction so a partial kill cannot occur. If
    // any write throws, the whole action rolls back and the catch below
    // returns 500.
    const now = new Date();
    let followupsCancelled = 0;
    let prospectPaused = false;

    await db.transaction(async (tx) => {
      // 1. Cancel the active follow-ups for this one prospect. Only the
      // non-terminal active statuses are touched; terminal and parked states
      // are left exactly as they are.
      const cancelled = await tx
        .update(followupsTable)
        .set({ status: "cancelled", errorMessage: KILL_CANCEL_MESSAGE })
        .where(and(
          eq(followupsTable.prospectId, id),
          inArray(followupsTable.status, [...KILL_ACTIVE_FOLLOWUP_STATUSES]),
        ))
        .returning({ id: followupsTable.id });
      followupsCancelled = cancelled.length;

      // 2. Pause this one campaign. This blocks re-queue. We do NOT touch
      // `replied`, sent history, `archived`, or the owning user's
      // paused_by_admin (no third layer for a campaign kill).
      const paused = await tx
        .update(prospectsTable)
        .set({ followupPaused: true, pauseReason: KILL_PAUSE_REASON, pausedAt: now })
        .where(eq(prospectsTable.id, id))
        .returning({ id: prospectsTable.id });
      if (paused.length === 0) {
        // The prospect vanished mid-transaction (concurrent delete). Throwing
        // rolls the whole kill back rather than leaving a partial state.
        throw new Error(`Prospect #${id} disappeared during kill`);
      }
      prospectPaused = true;
    });

    const summary: ProspectKillSummary = {
      followups_cancelled: followupsCancelled,
      prospect_paused: prospectPaused,
    };

    // Log the action (no LLM calls here, so token use and cost are zero).
    logger.info(
      {
        action: "admin_prospect_kill",
        prospectId: id,
        userId: prospect.userId,
        prospectName: prospect.prospectName,
        company: prospect.company,
        followups_cancelled: summary.followups_cancelled,
        prospect_paused: summary.prospect_paused,
        durationMs: Date.now() - startedAt,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      },
      "Admin Prospect Kill: campaign hard-stopped",
    );

    res.json({
      killed: true,
      prospect: {
        id: prospect.id,
        prospect_name: prospect.prospectName,
        company: prospect.company,
      },
      ...summary,
    });
  } catch (err) {
    logger.error({ err }, "Admin Prospect Kill failed; transaction rolled back");
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to kill campaign" });
  }
});

export default router;