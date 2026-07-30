// Admin global controls: pause/resume EVERY campaign at once.
//
//   POST /api/admin/pause-all     → app_settings.global_pause = 'true'
//   POST /api/admin/resume-all    → app_settings.global_pause = 'false'
//   GET  /api/admin/global-pause  → { paused: boolean, updated_at }
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

export default router;
