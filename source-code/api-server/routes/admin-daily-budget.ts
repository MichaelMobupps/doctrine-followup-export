// Admin daily budget controls: read live spend against the global cap, change
// the cap, and toggle enforcement.
//
//   GET  /api/admin/daily-budget   -> live state for the current budget day
//   POST /api/admin/daily-budget   -> { cap_usd?, enabled? } update either/both
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// The cap is global: it sums followup_usage.cost_usd across every user and
// every flow over the current budget day (local midnight, Asia/Jerusalem).
// Enforcement lives in scheduler.processDueFollowups.

import { Router, type Request, type Response } from "express";
import { getDailyBudgetState, setDailyBudget } from "../lib/dailyBudget";
import { logger } from "../lib/logger";
import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

function present(s: Awaited<ReturnType<typeof getDailyBudgetState>>) {
  return {
    enabled: s.enabled,
    cap_usd: s.capUsd,
    spent_usd: Number(s.spentUsd.toFixed(6)),
    remaining_usd: Number(s.remainingUsd.toFixed(6)),
    exceeded: s.exceeded,
    window_start: s.windowStartUtc.toISOString(),
    time_zone: s.timeZone,
    now: new Date().toISOString(),
  };
}

router.get("/admin/daily-budget", async (_req: Request, res: Response) => {
  try {
    const state = await getDailyBudgetState();
    res.json(present(state));
  } catch (err) {
    logger.error({ err }, "daily-budget state read failed");
    res.status(500).json({ error: "Failed to read daily budget state" });
  }
});

router.post("/admin/daily-budget", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { cap_usd?: unknown; enabled?: unknown };
    const update: { capUsd?: number; enabled?: boolean } = {};

    if (body.cap_usd !== undefined) {
      const cap = Number(body.cap_usd);
      if (!Number.isFinite(cap) || cap <= 0) {
        res.status(400).json({ error: "cap_usd must be a positive number" });
        return;
      }
      update.capUsd = cap;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      update.enabled = body.enabled;
    }
    if (update.capUsd === undefined && update.enabled === undefined) {
      res.status(400).json({ error: "Provide cap_usd and/or enabled" });
      return;
    }

    await setDailyBudget(update);
    const state = await getDailyBudgetState();
    logger.info(
      { capUsd: update.capUsd, enabled: update.enabled },
      "Admin updated daily budget",
    );
    res.json(present(state));
  } catch (err) {
    logger.error({ err }, "daily-budget update failed");
    res.status(500).json({ error: "Failed to update daily budget" });
  }
});

export default router;
