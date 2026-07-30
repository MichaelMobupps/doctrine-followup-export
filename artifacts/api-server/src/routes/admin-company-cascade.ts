// Admin controls for the Company-Reply Cascade.
//
//   GET  /api/admin/company-cascade          → { enabled, updated_at }
//   POST /api/admin/company-cascade/enable    → enable the feature
//   POST /api/admin/company-cascade/disable   → disable the feature (fail-safe)
//   GET  /api/admin/company-cascade/recent     → blast-radius audit: recent
//          cascade events, each a positive reply and the siblings it paused.
//          Optional ?limit= (default 50, max 200).
//   POST /api/admin/company-cascade/undo       → body { triggerProspectId }.
//          Un-pause every sibling a given reply paused; clears the cascade
//          reason and link so the scheduler re-queues those campaigns.
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// The cascade pauses RECENT sibling campaigns at the same company when one
// contact replies positively. Disabling here is a hard, fail-safe off switch:
// the engine also treats any settings-read error as disabled, so a transient
// DB problem never causes a wrongful pause.

import { Router, type Request, type Response } from "express";
import {
  getCompanyCascadeState,
  setCompanyCascadeEnabled,
  getRecentCascadeEvents,
  undoCascadeForTrigger,
} from "../services/companyCascade";
import { logger } from "../lib/logger";
import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

router.get("/admin/company-cascade", async (_req: Request, res: Response) => {
  try {
    const state = await getCompanyCascadeState();
    res.json({ enabled: state.enabled, updated_at: state.updatedAt });
  } catch (err) {
    logger.error({ err }, "company-cascade state read failed");
    res.status(500).json({ error: "Failed to read company cascade state" });
  }
});

router.post("/admin/company-cascade/enable", async (_req: Request, res: Response) => {
  try {
    await setCompanyCascadeEnabled(true);
    logger.info("Admin enabled the company-reply cascade");
    res.json({ enabled: true });
  } catch (err) {
    logger.error({ err }, "company-cascade enable failed");
    res.status(500).json({ error: "Failed to enable company cascade" });
  }
});

router.post("/admin/company-cascade/disable", async (_req: Request, res: Response) => {
  try {
    await setCompanyCascadeEnabled(false);
    logger.info("Admin disabled the company-reply cascade");
    res.json({ enabled: false });
  } catch (err) {
    logger.error({ err }, "company-cascade disable failed");
    res.status(500).json({ error: "Failed to disable company cascade" });
  }
});

router.get("/admin/company-cascade/recent", async (req: Request, res: Response) => {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(200, Math.trunc(raw))) : 50;
    const events = await getRecentCascadeEvents(limit);
    res.json({ events, count: events.length });
  } catch (err) {
    logger.error({ err }, "company-cascade recent read failed");
    res.status(500).json({ error: "Failed to read recent cascade events" });
  }
});

router.post("/admin/company-cascade/undo", async (req: Request, res: Response) => {
  try {
    const triggerProspectId = Number(req.body?.triggerProspectId);
    if (!Number.isInteger(triggerProspectId) || triggerProspectId <= 0) {
      res.status(400).json({ error: "triggerProspectId must be a positive integer" });
      return;
    }
    const restored = await undoCascadeForTrigger(triggerProspectId);
    logger.info({ triggerProspectId, restored }, "Admin undid a company-reply cascade");
    res.json({ triggerProspectId, restored });
  } catch (err) {
    logger.error({ err }, "company-cascade undo failed");
    res.status(500).json({ error: "Failed to undo company cascade" });
  }
});

export default router;
