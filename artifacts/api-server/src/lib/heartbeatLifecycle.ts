/**
 * heartbeatLifecycle.ts — F-3.7c. When a firing is recorded, and what happens
 * when that record cannot be written.
 *
 * Pure. No `@workspace/db`, no logger, no `process.env`, no clock of its own —
 * the store, the log, the clock and the sleep are all injected. That is the
 * same reasoning `processingGuard.ts` follows: the decisions this file makes
 * are exactly the ones that only show up when a write FAILS, and a proof of
 * behaviour-on-failure has to be able to make the failure happen on demand. A
 * module that imported `db` could only be tested through a live Postgres that
 * was cooperating, which is the one condition under which none of this matters.
 *
 * ── WHY THE ROW IS WRITTEN TWICE ─────────────────────────────────────────────
 *
 * Until this order a tick wrote one row, at the END of its body, with
 * `fired_at` defaulting to the instant of that write. Two consequences, and the
 * second one is the bug:
 *
 *   1. `last_fired_at` named the moment the tick FINISHED. Measured live on
 *      2026-08-17: `sync_and_autoqueue` fired at 18:00:00 and its row landed at
 *      18:05:19, so the age the Chief read was five minutes younger than the
 *      truth — a liveness signal that flatters itself by however long the work
 *      took.
 *   2. A firing whose write failed left NOTHING. `max(fired_at)` per tick is the
 *      Chief's machine liveness signal (F-3.7a), so a lost write is not a lost
 *      log line, it is a false death report: the age climbs past the alarm
 *      threshold, the next tick that manages to write clears it, and an
 *      operator gets one mail per flap about a cron that never missed a beat.
 *      The counter beside it barely moves — 479 of 480 reads as healthy — which
 *      is why the two figures appeared to contradict each other.
 *
 * So the row is INSERTED when the tick fires, carrying `outcome: 'running'`,
 * and UPDATED in place when the body finishes. One row per firing either way,
 * the age can never be inflated by the length of the work, and — the property
 * F-3.7b had to add a code path for — a tick that returns early cannot fail to
 * record itself, because its row already exists before the first decision.
 *
 * ── WHY A FAILED WRITE IS RETRIED, AND WHY IT IS STILL NOT FATAL ─────────────
 *
 * The pool is `max: 10` with a 15-second acquisition timeout, against a
 * serverless database that resets idle clients (`lib/db/src/index.ts`). A
 * generation pass holds connections across 30-90 second model calls. A
 * heartbeat insert is the smallest, least important statement in the process
 * and it is exactly the one that loses that race — and it used to lose it
 * silently, because `recordHeartbeat` caught, logged and returned.
 *
 * It is retried now, because a transient loss manufactures a false alarm. It is
 * still not allowed to throw, because the alternative — a tick that dies
 * because its bookkeeping did — would trade a false death report for a real
 * one. The compromise is loudness: a write that runs out of attempts says, in
 * one line, that this firing has left a hole and what the hole will look like
 * from the Chief.
 */

/** The stored `outcome` of a row whose tick has fired and not yet finished. */
export const HEARTBEAT_RUNNING = "running";

/**
 * The tick name a process start records under.
 *
 * Not a cron tick — an event. It exists because the other way a firing leaves
 * no row is that the process was not running: in-process `node-cron` fires
 * nothing while the app restarts, and until this order nothing said that a
 * restart had happened. A hole in the `fast_tick` stream with a `process_start`
 * row inside it is a restart; the same hole without one is a lost write.
 */
export const PROCESS_START_TICK = "process_start";

/**
 * Tick names that have no cadence, and are therefore withheld from the Chief.
 *
 * The Chief's staleness rule is "age exceeds a sane multiple of this tick's
 * cadence" (C-3.7b §4). A restart marker has no cadence — its age is however
 * long the process has been up, which is a number that SHOULD grow for ever —
 * so a cadence-based rule can only misread it. It stays on the admin surface,
 * where explaining a hole is the entire point of having it.
 */
export const NON_CADENCE_TICKS: readonly string[] = [PROCESS_START_TICK];

/** The outcomes a finished tick may report. Unchanged by this order. */
export type HeartbeatOutcome = "ok" | "partial" | "error";

/**
 * How many times one heartbeat statement is attempted.
 *
 * Three, with the waits below, is a worst case of roughly 49 seconds when the
 * pool is hung (15s acquisition timeout, 1s, 15s, 3s, 15s). That is bearable at
 * the top of the tightest tick — the 3-minute `fast_tick` — and it only happens
 * when the database is unreachable, which is a state in which the tick's real
 * work would do nothing anyway. Any longer ladder starts costing firings to
 * protect their own bookkeeping, which is the wrong way round.
 */
export const HEARTBEAT_WRITE_ATTEMPTS = 3;

/**
 * Waits BETWEEN attempts, so `HEARTBEAT_WRITE_ATTEMPTS - 1` of them.
 *
 * Short, and deliberately not exponential past the second step: the failure
 * this ladder exists for is a saturated pool draining as an LLM call returns,
 * which clears in seconds or not at all.
 */
export const HEARTBEAT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

export interface HeartbeatRow {
  outcome: HeartbeatOutcome;
  durationMs: number;
  details: Record<string, unknown> | null;
}

/**
 * The three statements this module needs. Implemented against the database in
 * `cronHeartbeat.ts`; implemented as a fake in the tests.
 *
 * Each one THROWS on failure — including `finishRow` when it matches no row.
 * The retry ladder is this module's job, not the store's.
 */
export interface HeartbeatStore {
  /** Insert the firing. Returns the row id. `fired_at` is the database's. */
  insertRunning(tickName: string): Promise<number>;
  /** Update that row with its result. */
  finishRow(id: number, row: HeartbeatRow): Promise<void>;
  /** Insert an already-finished row — the fallback, and one-shot records. */
  insertFinished(tickName: string, row: HeartbeatRow): Promise<void>;
}

export interface HeartbeatLog {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface HeartbeatDeps {
  store: HeartbeatStore;
  log: HeartbeatLog;
  /** Milliseconds. Only ever used for durations, never for a stored instant. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The handle a tick body holds between its firing and its result. */
export interface Heartbeat {
  /** The row id, or null when the firing could not be recorded at all. */
  readonly id: number | null;
  finish(args: { outcome: HeartbeatOutcome; details?: Record<string, unknown> }): Promise<void>;
}

export interface HeartbeatRecorder {
  /** Record that a tick has FIRED. Never throws. */
  begin(tickName: string): Promise<Heartbeat>;
  /**
   * Record a whole event in one statement. For things that have no duration to
   * measure — a process start — and for callers that legitimately only ever
   * have a finished fact to report.
   */
  record(args: {
    tickName: string;
    outcome: HeartbeatOutcome;
    durationMs?: number;
    details?: Record<string, unknown>;
  }): Promise<void>;
}

export function createHeartbeatRecorder(deps: HeartbeatDeps): HeartbeatRecorder {
  /**
   * Attempt one statement up to `HEARTBEAT_WRITE_ATTEMPTS` times.
   *
   * Never throws and never rethrows: every caller here is either at the top of
   * a cron tick or in its `finally`, and a heartbeat that can break a tick is
   * worse than a heartbeat that is missing.
   */
  async function attempt<T>(
    what: string,
    tickName: string,
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    for (let i = 0; i < HEARTBEAT_WRITE_ATTEMPTS; i++) {
      try {
        return { ok: true, value: await run() };
      } catch (err) {
        const last = i === HEARTBEAT_WRITE_ATTEMPTS - 1;
        if (last) {
          deps.log.error(
            { err, tickName, statement: what, attempts: HEARTBEAT_WRITE_ATTEMPTS },
            "F-3.7c: heartbeat write LOST after every attempt. This firing has " +
              "left a hole in cron_heartbeats, and a hole is what the Chief's " +
              "staleness alarm reads as a dead cron. The tick itself ran.",
          );
          return { ok: false };
        }
        deps.log.warn(
          { err, tickName, statement: what, attempt: i + 1 },
          "F-3.7c: heartbeat write failed; retrying",
        );
        const delay = HEARTBEAT_RETRY_DELAYS_MS[i] ?? HEARTBEAT_RETRY_DELAYS_MS[HEARTBEAT_RETRY_DELAYS_MS.length - 1] ?? 0;
        await deps.sleep(delay);
      }
    }
    // Unreachable while HEARTBEAT_WRITE_ATTEMPTS >= 1; kept total rather than
    // asserted, because this function's contract is that it does not throw.
    return { ok: false };
  }

  async function begin(tickName: string): Promise<Heartbeat> {
    const startedAt = deps.now();
    const inserted = await attempt("insert_running", tickName, () => deps.store.insertRunning(tickName));
    const id = inserted.ok ? inserted.value : null;
    let finished = false;

    return {
      id,
      async finish(args) {
        // A second finish would insert a duplicate row on the fallback path.
        // Nothing calls it twice today; this keeps that from being a property
        // of the call sites rather than of this module.
        if (finished) return;
        finished = true;

        const row: HeartbeatRow = {
          outcome: args.outcome,
          durationMs: Math.max(0, deps.now() - startedAt),
          details: args.details ?? null,
        };

        if (id !== null) {
          const done = await attempt("finish_row", tickName, () => deps.store.finishRow(id, row));
          if (!done.ok) {
            // The firing is still recorded and the age is still honest — only
            // the RESULT is missing. Said plainly, because a row left at
            // `running` for ever is a new artifact and the next reader of this
            // table deserves to know where it came from.
            deps.log.error(
              { tickName, heartbeatId: id, outcome: row.outcome },
              "F-3.7c: the heartbeat row stays at 'running' — its firing and its " +
                "age are recorded, its outcome and details are lost.",
            );
          }
          return;
        }

        // The firing was never recorded. Fall back to the pre-F-3.7c shape —
        // one finished row, written at the end — so a tick whose opening
        // insert lost the race still leaves the record it used to leave.
        await attempt("insert_finished_fallback", tickName, () =>
          deps.store.insertFinished(tickName, row),
        );
      },
    };
  }

  async function record(args: {
    tickName: string;
    outcome: HeartbeatOutcome;
    durationMs?: number;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await attempt("insert_finished", args.tickName, () =>
      deps.store.insertFinished(args.tickName, {
        outcome: args.outcome,
        durationMs: Math.max(0, args.durationMs ?? 0),
        details: args.details ?? null,
      }),
    );
  }

  return { begin, record };
}
