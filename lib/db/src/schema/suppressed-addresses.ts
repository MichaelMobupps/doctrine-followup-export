import { pgTable, serial, text, timestamp, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Global address suppression list. One row per suppressed email address.
// An address here is never emailed by any user in any subproduct.
//
// email is stored lowercased and is unique. reason records why it was
// suppressed ('hard_bounce' from automated detection, 'manual' from an
// operator do-not-contact request). source records where it came from
// (the bounce detail string, or the operator who added it).
export const suppressedAddressesTable = pgTable("suppressed_addresses", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  reason: text("reason").notNull(),
  source: text("source"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_suppressed_email").on(table.email),
]);

export type SuppressedAddress = typeof suppressedAddressesTable.$inferSelect;

export type SuppressionReason = "hard_bounce" | "manual";
