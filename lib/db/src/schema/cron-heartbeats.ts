// Phase 7n: cron heartbeat schema.
// One row per cron tick. tickName ∈ {sync_and_autoqueue, process_due,
// draft_stall_watcher, fast_tick, weekly_digest}. outcome ∈ {ok,
// partial, error}. details holds per-tick counts/errors as jsonb.
import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const cronHeartbeatsTable = pgTable("cron_heartbeats", {
  id: serial("id").primaryKey(),
  tickName: text("tick_name").notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
  outcome: text("outcome").notNull(),
  durationMs: integer("duration_ms").notNull().default(0),
  details: jsonb("details"),
}, (table) => [
  // Declared to match the index that already exists in both databases. Without
  // this declaration, drizzle-kit diffs it as undeclared and the deploy churns
  // a DROP/CREATE on every Republish. The column order matches production.
  index("idx_cron_heartbeats_tick_fired_at").on(table.tickName, table.firedAt),
]);
