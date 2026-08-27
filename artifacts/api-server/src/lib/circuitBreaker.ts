// circuitBreaker.ts — a tiny, pure circuit breaker.
//
// Used to stop hammering an upstream model while it is at full capacity or
// unavailable. After `failureThreshold` consecutive failures the breaker OPENS
// for `cooldownMs`; while open, callers route straight to the next tier in the
// role's waterfall (lib/llmRouter.ts keeps one breaker per model) instead of
// paying the upstream's retry latency on every call. After the cooldown, one probe is allowed (half-open): a success closes
// the breaker, a failure re-opens it for another cooldown.
//
// Pure and clock-injectable (every method takes an optional `now`) so it is
// hermetically testable, following the pattern of followupLimits.ts /
// adminKill.ts. State lives in the closure; one breaker instance is created
// per upstream at module load.

export interface CircuitBreaker {
  // True when a call to the upstream should be attempted now (closed, or
  // half-open after the cooldown). False while the breaker is open.
  shouldAttempt(now?: number): boolean;
  // Record an upstream success. Closes the breaker and clears the failure run.
  onSuccess(): void;
  // Record an upstream failure. Opens the breaker once the consecutive-failure
  // run reaches the threshold.
  onFailure(now?: number): void;
  // Introspection for logging and tests.
  state(now?: number): { open: boolean; consecutiveFailures: number; openUntil: number };
}

export function createCircuitBreaker(opts: {
  failureThreshold: number;
  cooldownMs: number;
}): CircuitBreaker {
  if (opts.failureThreshold < 1) {
    throw new Error("failureThreshold must be >= 1");
  }
  let consecutiveFailures = 0;
  let openUntil = 0;

  const isOpen = (now: number): boolean => now < openUntil;

  return {
    shouldAttempt(now = Date.now()) {
      return !isOpen(now);
    },
    onSuccess() {
      consecutiveFailures = 0;
      openUntil = 0;
    },
    onFailure(now = Date.now()) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= opts.failureThreshold) {
        openUntil = now + opts.cooldownMs;
      }
    },
    state(now = Date.now()) {
      return { open: isOpen(now), consecutiveFailures, openUntil };
    },
  };
}
