import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";

/**
 * F-3.7a: how much of each UTC day's spend the Chief has already confirmed.
 *
 * One row per (UTC day, vendor). `reported_cents` is the running TOTAL this app
 * has had accepted, in whole cents — never a chunk counter. That distinction is
 * load-bearing: a counter multiplied by a configurable quantum would
 * DOUBLE-REPORT real money the first time the quantum was lowered, because the
 * chunks already sent at the old size would be re-sent at the new one under
 * fresh ids. A dollar figure cannot drift that way. (The Prospector learned this
 * one in P-3.1c; the shape here is deliberately the same.)
 *
 * NO INITIATOR COLUMN, unlike the Prospector's twin. Every dollar this app
 * spends is human-caused — there is no inbound command seam for a
 * chief-attributed one to come from, and F-3.7a v1 deliberately does not add
 * one. The order that adds it must widen this key and the `external_id`
 * namespace TOGETHER, leaving the human form of both unchanged; see
 * `chiefSpendExternalId()` for why the human ids must not move a byte.
 *
 * WHY IT IS DECLARED HERE AS WELL AS IN THE STARTUP MIGRATION. The migration is
 * what creates it (`api-server/src/lib/startupMigrations.ts`, the only schema
 * mechanism this repo has). This declaration exists so `drizzle-kit push` sees a
 * table it knows about rather than an undeclared one it might offer to DROP —
 * the mirror image of the churn trap `cron-heartbeats.ts` records. The two
 * definitions must therefore stay byte-compatible, INCLUDING the primary-key
 * CONSTRAINT NAME, which is why it is written out explicitly on both sides
 * instead of being left to each tool's default.
 *
 * Losing this table is survivable, not corrupting: the reporter re-sends reports
 * the Chief already holds, and the Chief dedupes them on `(app, external_id)`
 * because a report's amount is a pure function of its id.
 */
export const chiefSpendCursorTable = pgTable(
  "chief_spend_cursor",
  {
    /** `YYYY-MM-DD`, UTC. The same key that appears in the `external_id`. */
    dayKey: text("day_key").notNull(),
    /** `anthropic` | `google` | `openai` | `other` — see `vendorForModel()`. */
    vendor: text("vendor").notNull(),
    reportedCents: integer("reported_cents").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "chief_spend_cursor_day_key_vendor_pk",
      columns: [table.dayKey, table.vendor],
    }),
  ],
);

export type ChiefSpendCursor = typeof chiefSpendCursorTable.$inferSelect;
