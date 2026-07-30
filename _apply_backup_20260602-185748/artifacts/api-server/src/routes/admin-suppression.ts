// Admin suppression-list controls.
//
//   GET    /api/admin/suppression            → { count, addresses: [...] }
//   POST   /api/admin/suppression  {email}    → add a manual suppression
//   DELETE /api/admin/suppression  {email}    → remove (un-suppress)
//
// Auth: requireAdmin (x-admin-key must match ADMIN_API_KEY).
//
// A suppressed address is never emailed by any user in any subproduct. Hard
// bounces add addresses automatically (see gmailSync); this route is for the
// admin view plus manual do-not-contact add/remove.

import { Router, type Request, type Response } from "express";
import { listSuppressed, suppressAddress, unsuppressAddress, countSuppressed, normalizeEmail } from "../lib/suppression";
import { logger } from "../lib/logger";

import { requireAdmin } from "../middlewares/requireAdmin";

const router = Router();

router.use(requireAdmin);

router.get("/admin/suppression", async (_req: Request, res: Response) => {
  try {
    const [count, addresses] = await Promise.all([countSuppressed(), listSuppressed(1000)]);
    res.json({ count, addresses });
  } catch (err) {
    logger.error({ err }, "list suppression failed");
    res.status(500).json({ error: "Failed to list suppressed addresses" });
  }
});

router.post("/admin/suppression", async (req: Request, res: Response) => {
  const email = normalizeEmail(String((req.body && (req.body as any).email) || ""));
  if (!email || !email.includes("@")) { res.status(400).json({ error: "Valid email required" }); return; }
  try {
    await suppressAddress(email, "manual", "manual admin add");
    res.json({ success: true, email });
  } catch (err) {
    logger.error({ err }, "add suppression failed");
    res.status(500).json({ error: "Failed to suppress address" });
  }
});

router.delete("/admin/suppression", async (req: Request, res: Response) => {
  const email = normalizeEmail(String((req.body && (req.body as any).email) || ""));
  if (!email) { res.status(400).json({ error: "Email required" }); return; }
  try {
    const removed = await unsuppressAddress(email);
    res.json({ success: true, removed });
  } catch (err) {
    logger.error({ err }, "remove suppression failed");
    res.status(500).json({ error: "Failed to un-suppress address" });
  }
});

export default router;
