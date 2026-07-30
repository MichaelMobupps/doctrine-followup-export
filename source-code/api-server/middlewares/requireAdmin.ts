// requireAdmin.ts — the single admin guard for every /api/admin/* router.
//
// It is DISTINCT from the shared-key authMiddleware that protects the normal
// app (which checks x-api-key against ADDON_API_KEY). This guard checks the
// x-admin-key header against ADMIN_API_KEY, a separate secret that is only
// ever handed to allowlisted admins at the OAuth exchange (see
// routes/auth.ts + lib/adminAccess.ts). A normal sales manager holds only the
// shared ADDON_API_KEY and never receives ADMIN_API_KEY, so they cannot reach
// any admin endpoint by any path the client controls.
//
// Fail-closed semantics (matching lib/adminAccess.resolveAdminGrant):
//   - ADMIN_API_KEY unset on the server                → 500 (misconfigured).
//   - x-admin-key header missing or wrong              → 403 (forbidden).
//   - x-admin-key equals ADMIN_API_KEY                 → next().
//
// We never compare against an empty string: if ADMIN_API_KEY is unset we 500
// BEFORE looking at the header, so an empty/absent header can never "match" an
// empty expected value.

import { type Request, type Response, type NextFunction } from "express";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    res.status(500).json({ error: "ADMIN_API_KEY not set" });
    return;
  }
  const provided = req.headers["x-admin-key"];
  if (!provided || provided !== expected) {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

export default requireAdmin;