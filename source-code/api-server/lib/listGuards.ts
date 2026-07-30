// listGuards.ts — server-side guard against unbounded list responses.
//
// 2026-07-16 main-screen-hang incident: the /followups and /prospects list
// endpoints accepted fully unfiltered requests and answered with up to
// 50,000 rows × full email bodies (original_body + generated_body) in one
// synchronous res.json(). JSON.stringify of that payload blocked the Node
// event loop for EVERY user of the process, and the requesting browser tab
// froze downloading/parsing it — the dashboard main screen "loaded emails
// indefinitely" and clicks (Settings, navigation) went dead.
//
// The dashboard hit this whenever a login's identity did not resolve to a
// connected account (userId omitted). The frontend is fixed to never issue
// that request, but the server must not rely on client behaviour: this
// guard rejects any list request with no narrowing filter on a multi-user
// install, whatever the client.
//
// Legacy single-user installs (empty users table, env-var credentials,
// prospects rows carry user_id NULL) keep the old unfiltered behaviour —
// there is no userId those rows could be addressed by, and the dataset is
// one mailbox.

import type { Request, Response } from "express";
import { db, usersTable } from "@workspace/db";

// Cached "is this a multi-user install?" probe. A user row is only ever
// INSERTed (Gmail connect) — installs never go back to zero users in
// practice — so a positive answer is safe to cache for the process
// lifetime. A negative answer is re-checked on every call so the first
// Gmail connect flips the guard on without a restart.
let knownMultiUser = false;

async function isMultiUserInstall(): Promise<boolean> {
  if (knownMultiUser) return true;
  const [anyUser] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  if (anyUser) knownMultiUser = true;
  return knownMultiUser;
}

// Pure decision: does this query string carry at least one usable narrowing
// param? Exported for hermetic tests. Empty-string values do not count —
// `?userId=` narrows nothing (parseInt("") is NaN and drizzle eq(NaN)
// matches nothing useful).
export function hasNarrowingParam(
  query: Record<string, unknown>,
  narrowers: string[],
): boolean {
  return narrowers.some((p) => {
    const v = query[p];
    return v !== undefined && v !== "";
  });
}

/**
 * Sends a 400 and returns true when a list request carries NO narrowing
 * query param on a multi-user install. Returns false (caller proceeds)
 * when any narrower is present or the install is legacy single-user.
 *
 * `narrowers` are the route's supported narrowing params (e.g. userId,
 * status, email). includeArchived is a widener, never a narrower.
 */
export async function rejectUnboundedList(
  req: Request,
  res: Response,
  narrowers: string[],
): Promise<boolean> {
  if (hasNarrowingParam(req.query as Record<string, unknown>, narrowers)) return false;
  if (!(await isMultiUserInstall())) return false;
  res.status(400).json({
    error:
      `Unfiltered listing is not available on multi-user installs — pass at least one of: ${narrowers.join(", ")}. ` +
      "An unfiltered response would contain every user's data and is too large to serve.",
  });
  return true;
}
