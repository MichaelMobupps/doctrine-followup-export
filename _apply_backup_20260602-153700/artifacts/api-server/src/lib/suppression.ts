import { db, suppressedAddressesTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { logger } from "./logger";
import { normalizeEmail } from "./emailNormalize";

// Global address suppression. A suppressed address is never emailed by any
// user in any subproduct. Hard bounces add addresses automatically; operators
// can add or remove by hand for do-not-contact requests.

// Re-exported so existing import sites (`import { normalizeEmail } from
// "../lib/suppression"`) keep working unchanged.
export { normalizeEmail };

// Add one address to the suppression list. Idempotent: a repeat insert keeps
// the original row (and its reason) rather than overwriting it.
export async function suppressAddress(
  email: string,
  reason: "hard_bounce" | "manual",
  source?: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return;
  await db
    .insert(suppressedAddressesTable)
    .values({ email: normalized, reason, source: source ?? null })
    .onConflictDoNothing({ target: suppressedAddressesTable.email });
  logger.info({ email: normalized, reason }, "Address suppressed");
}

// True if the address is on the suppression list.
export async function isSuppressed(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const rows = await db
    .select({ id: suppressedAddressesTable.id })
    .from(suppressedAddressesTable)
    .where(eq(suppressedAddressesTable.email, normalized))
    .limit(1);
  return rows.length > 0;
}

// Remove an address from the suppression list.
export async function unsuppressAddress(email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const result = await db
    .delete(suppressedAddressesTable)
    .where(eq(suppressedAddressesTable.email, normalized));
  return Boolean(result.rowCount);
}

export async function listSuppressed(limit = 1000): Promise<
  Array<{ email: string; reason: string; source: string | null; created_at: string }>
> {
  const rows = await db
    .select()
    .from(suppressedAddressesTable)
    .orderBy(desc(suppressedAddressesTable.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    email: r.email,
    reason: r.reason,
    source: r.source,
    created_at: r.createdAt.toISOString(),
  }));
}

export async function countSuppressed(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)`.mapWith(Number) })
    .from(suppressedAddressesTable);
  return rows[0]?.c ?? 0;
}
