// Phase 7n: one row per cron tick.
// F-3.7c: the row is now written when the tick FIRES and updated when it
// finishes, and the write is retried instead of being swallowed. The decisions
// live in lib/heartbeatLifecycle.ts, which imports no database; this file is
// only the wiring — the three statements, the real clock, the real logger.
import { db, cronHeartbeatsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  type Heartbeat,
  type HeartbeatOutcome,
  type HeartbeatRow,
  type HeartbeatStore,
  HEARTBEAT_RUNNING,
  PROCESS_START_TICK,
  createHeartbeatRecorder,
} from "./heartbeatLifecycle";

/** The name this outcome type has been imported by since Phase 7n. */
export type CronOutcome = HeartbeatOutcome;
export type { Heartbeat };

const store: HeartbeatStore = {
  async insertRunning(tickName: string): Promise<number> {
    // `fired_at` is left to the column default — `NOW()`, the DATABASE clock,
    // evaluated as this statement runs, which is the firing. The app clock
    // never stamps a stored instant; the readers compare against the same
    // `now()`, so the age and the 24h counters can never disagree about time.
    const rows = await db
      .insert(cronHeartbeatsTable)
      .values({
        tickName,
        outcome: HEARTBEAT_RUNNING,
        durationMs: 0,
        details: null,
      })
      .returning({ id: cronHeartbeatsTable.id });
    const id = rows[0]?.id;
    if (typeof id !== "number") {
      // Cannot happen with RETURNING against a serial primary key; treated as a
      // failure rather than trusted, so the retry ladder sees it.
      throw new Error("cron heartbeat insert returned no id");
    }
    return id;
  },

  async finishRow(id: number, row: HeartbeatRow): Promise<void> {
    const rows = await db
      .update(cronHeartbeatsTable)
      .set({
        outcome: row.outcome,
        durationMs: row.durationMs,
        details: row.details,
      })
      .where(eq(cronHeartbeatsTable.id, id))
      .returning({ id: cronHeartbeatsTable.id });
    if (rows.length === 0) {
      // The row this tick inserted is gone. Nothing deletes from this table, so
      // this is a real anomaly and not a race: it throws so the ladder retries
      // and then says so out loud.
      throw new Error(`cron heartbeat row ${id} was not found on finish`);
    }
  },

  async insertFinished(tickName: string, row: HeartbeatRow): Promise<void> {
    await db.insert(cronHeartbeatsTable).values({
      tickName,
      outcome: row.outcome,
      durationMs: row.durationMs,
      details: row.details,
    });
  },
};

const recorder = createHeartbeatRecorder({
  store,
  log: logger,
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

/**
 * Record that a tick has FIRED. Call it as the first statement of the body, and
 * finish the returned handle in a `finally`. Never throws.
 *
 * The duration the row ends up carrying is measured from this call, so no tick
 * body keeps its own `startedAt` any more.
 */
export async function beginHeartbeat(tickName: string): Promise<Heartbeat> {
  return recorder.begin(tickName);
}

/**
 * Record a finished event in one statement, for things with no body to time.
 * Never throws.
 */
export async function recordHeartbeat(args: {
  tickName: string;
  outcome: CronOutcome;
  durationMs?: number;
  details?: Record<string, unknown>;
}): Promise<void> {
  return recorder.record(args);
}

/**
 * One row per process start.
 *
 * This is the difference between "the cron died" and "the app restarted", and
 * before F-3.7c nothing in the database could tell them apart: a redeploy or a
 * crash-restart takes the in-process scheduler with it, so the firings that
 * would have happened simply are not there, and the age the Chief reads climbs
 * exactly as it would for a dead tick.
 *
 * Deliberately fire-and-forget with its own error swallowed by the recorder:
 * boot must not wait on it, and must not fail on it.
 */
export function recordProcessStart(details?: Record<string, unknown>): void {
  void recordHeartbeat({
    tickName: PROCESS_START_TICK,
    outcome: "ok",
    details: { reason: "process start", ...details },
  });
}
