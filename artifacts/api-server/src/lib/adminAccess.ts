// adminAccess.ts — pure, dependency-free helpers for the real admin gate.
//
// The admin surface (the kills, the admin dashboard, per-user admin
// pause/resume, global controls, suppression) is gated on a SEPARATE secret
// (ADMIN_API_KEY) that is issued ONLY to allowlisted people at the OAuth
// exchange. This module carries the one piece of non-trivial logic that the
// exchange needs — deciding, from the OAuth-verified email and the
// server-side ADMIN_EMAILS allowlist, whether a login is an admin login.
//
// It is intentionally free of any Express / DB / network import so it can be
// unit-tested hermetically under api-server/src/tests (the only test gate).
//
// SECURITY NOTE: the only trustworthy email is the OAuth-verified one resolved
// at /auth/exchange. A client-asserted email must NEVER be fed to these
// helpers to decide admin status. The shared ADDON_API_KEY cannot identify a
// user; ADMIN_API_KEY is a distinct secret handed back only to admins.

// Parse the comma-separated ADMIN_EMAILS list into a normalised set of
// lowercase, trimmed addresses. Tolerates null/undefined/empty and stray
// whitespace/empty entries.
export function parseAdminEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// True when the (OAuth-verified) email is in the ADMIN_EMAILS allowlist.
// Comparison is case-insensitive and trim-tolerant on both sides. An empty or
// missing email is never an admin.
export function isAdminEmail(
  email: string | null | undefined,
  adminEmailsRaw: string | null | undefined,
): boolean {
  const target = (email ?? "").trim().toLowerCase();
  if (!target) return false;
  const list = parseAdminEmails(adminEmailsRaw);
  return list.includes(target);
}

// Decide, at the OAuth exchange, whether to issue an admin token and what to
// return. Fails CLOSED on two independent conditions:
//   1. ADMIN_API_KEY is unset on the server  → nobody is admin, no token.
//   2. The verified email is not in ADMIN_EMAILS → not admin, no token.
// When admin, returns the real ADMIN_API_KEY as the adminToken. The adminToken
// is only ever a non-empty string when isAdmin is true, so an unset key can
// never be handed back as an empty string that would match an empty header.
export function resolveAdminGrant(
  verifiedEmail: string | null | undefined,
  adminEmailsRaw: string | null | undefined,
  adminApiKey: string | null | undefined,
): { isAdmin: boolean; adminToken?: string } {
  const key = (adminApiKey ?? "").trim();
  if (!key) return { isAdmin: false };
  if (!isAdminEmail(verifiedEmail, adminEmailsRaw)) return { isAdmin: false };
  return { isAdmin: true, adminToken: key };
}