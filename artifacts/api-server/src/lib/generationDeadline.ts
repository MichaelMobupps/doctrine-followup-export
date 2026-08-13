/**
 * generationDeadline.ts — F-3.7b.
 *
 * A wall-clock budget for ONE row's generation, and nothing else.
 *
 * WHAT THIS BOUNDS
 *
 * Every vendor call already has a per-call cap: the Anthropic SDK is
 * constructed with `timeout: 60_000` (lib/anthropic.ts) and the Gemini client
 * aborts at `GEMINI_TIMEOUT_MS`, default 60s (lib/gemini.ts). Each RETRY LADDER
 * is bounded too — withAnthropicRetry carries `totalBudgetMs`, default 90s.
 *
 * What has never been bounded is the number of ladders a single row may stack.
 * Note where the 90s budget actually binds: it is checked before deciding to
 * retry, so a ladder can start a fresh 60s attempt at 89s elapsed and legally
 * reach ~150s.
 *
 *   Gemini primary tier   3 attempts x 60s + backoff        ~ 182s
 *   Anthropic draft       ladder ~150s, x2 for the
 *                         2-attempt JSON-parse retry        ~ 300s
 *   Anthropic critic      ladder                            ~ 150s
 *   Anthropic rewriter    ladder                            ~ 150s
 *                                                    total  ~ 13 minutes
 *
 * Thirteen minutes for ONE row, inside a tick that fires every three. That tail
 * is what let passes run 40 minutes, and a pass that runs 40 minutes is what
 * suppressed every fast_tick behind it (see cron.ts).
 *
 * WHY 180 SECONDS
 *
 * A full happy-path generation is three sequential vendor calls — draft,
 * critic, and an optional rewrite — and each is capped at 60s. 180s is
 * therefore exactly the sum of the per-call caps for a complete generation in
 * which every call runs to its worst permitted latency. The deadline cannot
 * cut a generation that is merely slow while making progress inside those
 * caps; it cuts precisely the thing the caps do not bound, which is retry
 * ladders stacking on top of one another.
 *
 * It is also one fast_tick period, so a single row can never cost more than
 * one tick.
 *
 * HOW IT BINDS, AND THE ONE OVERSHOOT IT ALLOWS
 *
 * Two mechanisms, because either alone is insufficient:
 *
 *   1. A hard race in `withGenerationDeadline`. At the deadline the caller's
 *      promise rejects and the row fails immediately, so the PASS is bounded
 *      whatever the vendor call is doing. This is the part that protects the
 *      tick.
 *
 *   2. An AsyncLocalStorage budget the retry layers read. `withAnthropicRetry`
 *      and the Gemini attempt loop refuse to START work once the budget is
 *      spent, and clamp a request that would outlive it. This is the part that
 *      protects the money: without it the abandoned chain would keep climbing
 *      its retry ladder in the background, billing for a row nobody is waiting
 *      for — the exact shape of the F-D4 burn, 1,278 LLM calls on 49
 *      follow-ups.
 *
 * The overshoot this deliberately allows: a call already in flight when the
 * deadline lands is not aborted mid-request, it is abandoned. Its own SDK cap
 * bounds it at 60s, no further attempt starts behind it, and its result is
 * discarded. So a row costs at most `deadline + 60s` of vendor time and
 * exactly `deadline` of pass time. Aborting in flight would buy the last 60s
 * of billing back at the cost of threading a signal through every generator;
 * the pass-time bound is what this order is about, and that is already hard.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * One row's generation budget. See the header for why this number.
 *
 * Deliberately not env-tunable: it is a load-bearing relationship with the
 * 60s per-call caps and the 3-minute tick, not a knob.
 */
export const GENERATION_DEADLINE_MS = 180_000;

/**
 * Thrown when a row's generation budget is spent.
 *
 * It carries no Gmail artifact id, by construction: the deadline only ever
 * wraps generation, which runs entirely before the first Gmail write. So
 * `classifyProcessingFailure` reads it as `send_error` — a bounded-retry
 * class under the F-3.6a policy (MAX_AUTO_RETRIES = 2), not the terminal
 * `stranded` class. A deadlined row is retried twice and then stays failed
 * and visible, which is the correct treatment: nothing was delivered, so
 * there is nothing to duplicate.
 */
export class GenerationDeadlineError extends Error {
  readonly deadlineMs: number;
  readonly elapsedMs: number;

  constructor(deadlineMs: number, elapsedMs: number) {
    super(
      `Generation exceeded its ${Math.round(deadlineMs / 1000)}s deadline ` +
        `(${Math.round(elapsedMs / 1000)}s elapsed) — this row was abandoned so the ` +
        `rest of the pass could run. No email or draft was created.`,
    );
    this.name = "GenerationDeadlineError";
    this.deadlineMs = deadlineMs;
    this.elapsedMs = elapsedMs;
  }
}

interface DeadlineScope {
  deadlineAt: number;
  deadlineMs: number;
  startedAt: number;
}

const storage = new AsyncLocalStorage<DeadlineScope>();

/**
 * Milliseconds left in the current row's budget.
 *
 * `null` — not `0` — when there is no deadline in scope, so callers outside a
 * generation (a route, a script, a test) are unaffected rather than instantly
 * expired. Every reader below distinguishes the two.
 */
export function remainingGenerationMs(): number | null {
  const scope = storage.getStore();
  if (!scope) return null;
  return scope.deadlineAt - Date.now();
}

/** True only when a deadline is in scope AND it has passed. */
export function generationDeadlineExceeded(): boolean {
  const remaining = remainingGenerationMs();
  return remaining !== null && remaining <= 0;
}

/**
 * Throw if the current row's budget is spent. Called by the retry layers
 * before starting an attempt, so a spent budget stops the ladder instead of
 * climbing it for a row that has already been abandoned.
 */
export function assertGenerationBudget(label: string): void {
  const scope = storage.getStore();
  if (!scope) return;
  const elapsed = Date.now() - scope.startedAt;
  if (Date.now() >= scope.deadlineAt) {
    const err = new GenerationDeadlineError(scope.deadlineMs, elapsed);
    err.message = `${err.message} (stopped before starting: ${label})`;
    throw err;
  }
}

/**
 * Clamp a per-call timeout to what is left of the row's budget.
 *
 * A call that cannot possibly finish inside the budget should not be given
 * the full 60s to discover that. With no deadline in scope the caller's own
 * value is returned untouched.
 */
export function clampToGenerationBudget(timeoutMs: number): number {
  const remaining = remainingGenerationMs();
  if (remaining === null) return timeoutMs;
  if (remaining <= 0) return 1;
  return Math.min(timeoutMs, remaining);
}

/**
 * Run `fn` under a generation budget.
 *
 * Rejects with GenerationDeadlineError at the deadline whatever `fn` is doing.
 * The timer is unref'd so a pending deadline can never hold the process open.
 */
export function withGenerationDeadline<T>(
  fn: () => Promise<T>,
  deadlineMs: number = GENERATION_DEADLINE_MS,
): Promise<T> {
  const startedAt = Date.now();
  const scope: DeadlineScope = {
    startedAt,
    deadlineMs,
    deadlineAt: startedAt + deadlineMs,
  };

  return storage.run(scope, () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wall = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new GenerationDeadlineError(deadlineMs, Date.now() - startedAt)),
        deadlineMs,
      );
      // A deadline that has not fired must never be the reason the process
      // stays alive.
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });

    return Promise.race([fn(), wall]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  });
}

/** Test seam: run `fn` with a deadline already spent. */
export function __runWithSpentBudgetForTests<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now() - 1000;
  return storage.run({ startedAt, deadlineMs: 500, deadlineAt: startedAt + 500 }, fn);
}
