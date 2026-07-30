// Admin global controls: pause/resume EVERY campaign at once.
//
//   POST /api/admin/pause-all     → app_settings.global_pause = 'true'
//   POST /api/admin/resume-all    → app_settings.global_pause = 'false'
//   GET  /api/admin/global-pause  → { paused: boolean, updated_at }
//   POST /api/admin/stop-stale    → run both auto-pause sweeps NOW (age + over-cap)
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// Effect on the scheduler:
//   - processDueFollowups: bulk cron path returns early while paused.
//     Explicit single-item sends (forceSend with a followupId) still run,
//     so an operator can push one message through if needed.
//   - autoQueueAllCampaigns: returns 0 while paused (no new stages queued).
//   - Gmail sync and bounce/reply detection keep running, so the dashboard
//     stays current and bounces are still caught while sending is paused.
//
// Per-user pauses (users.paused_by_admin) are untouched by this switch.

import { Router, type Request, type Response } from "express";
import { setGlobalPause, getGlobalPauseState } from "../lib/globalPause";
import { pauseExpiredCampaigns, pauseOverCapCampaigns } from "../services/scheduler";
import { logger } from "../lib/logger";

import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

router.get("/admin/global-pause", async (_req: Request, res: Response) => {
  try {
    const state = await getGlobalPauseState();
    res.json({ paused: state.paused, updated_at: state.updatedAt });
  } catch (err) {
    logger.error({ err }, "global-pause state read failed");
    res.status(500).json({ error: "Failed to read global pause state" });
  }
});

router.post("/admin/pause-all", async (_req: Request, res: Response) => {
  try {
    await setGlobalPause(true);
    logger.info("Admin paused ALL campaigns (global switch)");
    res.json({ paused: true });
  } catch (err) {
    logger.error({ err }, "pause-all failed");
    res.status(500).json({ error: "Failed to pause all campaigns" });
  }
});

router.post("/admin/resume-all", async (_req: Request, res: Response) => {
  try {
    await setGlobalPause(false);
    logger.info("Admin resumed ALL campaigns (global switch)");
    res.json({ paused: false });
  } catch (err) {
    logger.error({ err }, "resume-all failed");
    res.status(500).json({ error: "Failed to resume all campaigns" });
  }
});

// On-demand kill switch for stale campaigns. Runs the same two daily sweeps
// immediately instead of waiting for the 00:15 / 00:20 UTC cron:
//   - pauseExpiredCampaigns(): every active campaign whose original outreach
//     was sent more than 30 days ago, across all users and subproducts.
//   - pauseOverCapCampaigns(): every active campaign that has already sent
//     more than the cap within a cycle (cycle-aware; legacy over-cap rows).
// Both cancel the scheduled follow-ups (and their Gmail drafts) and pause the
// campaign with the matching pause_reason. Idempotent: already-paused
// campaigns are skipped, so the operator can click it repeatedly with no harm.
router.post("/admin/stop-stale", async (_req: Request, res: Response) => {
  try {
    const expiredPaused = await pauseExpiredCampaigns();
    const overCapPaused = await pauseOverCapCampaigns();
    const total = expiredPaused + overCapPaused;
    logger.info(
      { expiredPaused, overCapPaused, total },
      "Admin ran stop-stale sweeps on demand",
    );
    res.json({ expired_paused: expiredPaused, over_cap_paused: overCapPaused, total });
  } catch (err) {
    logger.error({ err }, "stop-stale sweep failed");
    res.status(500).json({ error: "Failed to stop stale campaigns" });
  }
});

export default router;
