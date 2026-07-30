// Phase 7n: recordHeartbeat helper. One row per cron tick.
// Wrapped in try/catch so a DB hiccup on heartbeat-recording can
// never kill the actual cron work — heartbeats are observability
// only.
import { db, cronHeartbeatsTable } from "@workspace/db";
import { logger } from "./logger";

export type CronOutcome = "ok" | "partial" | "error";

export async function recordHeartbeat(args: {
  tickName: string;
  durationMs: number;
  outcome: CronOutcome;
  details?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(cronHeartbeatsTable).values({
      tickName: args.tickName,
      durationMs: args.durationMs,
      outcome: args.outcome,
      details: args.details ?? null,
    });
  } catch (err) {
    logger.error({ err, tickName: args.tickName }, "Failed to record cron heartbeat");
  }
}
