// B7u: admin pause/resume for a user.
//
// POST /api/admin/users/:id/pause     → sets users.paused_by_admin = true
// POST /api/admin/users/:id/resume    → sets users.paused_by_admin = false
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// Effect on the scheduler:
//   - sync_and_autoqueue excludes paused users from its connectedUsers
//     query → no new auto-queueing for paused users
//   - processDueFollowups checks userCache.get(item.userId).pausedByAdmin
//     and skips the row, leaving it in queued status until unpaused
//
// Existing queued rows for the user stay in 'queued' state; nothing
// is cancelled. Resume simply makes them eligible again.

import { Router, type Request, type Response } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";

import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

async function setPaused(id: number, paused: boolean): Promise<{ ok: boolean; user?: { id: number; email: string; paused_by_admin: boolean } }> {
  const updated = await db
    .update(usersTable)
    .set({ pausedByAdmin: paused })
    .where(eq(usersTable.id, id))
    .returning({
      id: usersTable.id,
      email: usersTable.email,
      paused_by_admin: usersTable.pausedByAdmin,
    });
  if (updated.length === 0) return { ok: false };
  return { ok: true, user: updated[0] };
}

router.post("/admin/users/:id/pause", async (req: Request, res: Response) => {
  try {
    const id = parseInt((req.params.id as string), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid user id" }); return; }
    const { ok, user } = await setPaused(id, true);
    if (!ok) { res.status(404).json({ error: `User #${id} not found` }); return; }
    logger.info({ userId: id, email: user?.email }, "B7u: user paused by admin");
    res.json({ paused: true, user });
  } catch (err) {
    logger.error({ err }, "B7u: pause failed");
    res.status(500).json({ error: "Failed to pause user" });
  }
});

router.post("/admin/users/:id/resume", async (req: Request, res: Response) => {
  try {
    const id = parseInt((req.params.id as string), 10);
    if (!Number.isFinite(id)) { res.status(400).json({ error: "Invalid user id" }); return; }
    const { ok, user } = await setPaused(id, false);
    if (!ok) { res.status(404).json({ error: `User #${id} not found` }); return; }
    logger.info({ userId: id, email: user?.email }, "B7u: user resumed by admin");
    res.json({ paused: false, user });
  } catch (err) {
    logger.error({ err }, "B7u: resume failed");
    res.status(500).json({ error: "Failed to resume user" });
  }
});

export default router;
