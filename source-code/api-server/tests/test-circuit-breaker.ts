/**
 * test-circuit-breaker.ts
 *
 * Hermetic tests for the pure circuit breaker in lib/circuitBreaker.ts (used to
 * guard the Gemini critic). No DB, no network, clock injected via `now`.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-circuit-breaker.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import { createCircuitBreaker } from "../lib/circuitBreaker";

test.describe("circuitBreaker", () => {
  test.it("starts closed — attempts are allowed", () => {
    const b = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    assert.equal(b.shouldAttempt(0), true);
  });

  test.it("opens at the threshold and stays open through the cooldown", () => {
    const b = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    b.onFailure(0);
    b.onFailure(0);
    assert.equal(b.shouldAttempt(0), true, "below threshold: still closed");
    b.onFailure(0); // 3rd consecutive failure → open until 1000
    assert.equal(b.shouldAttempt(0), false, "at threshold: open");
    assert.equal(b.shouldAttempt(999), false, "within cooldown: still open");
    assert.equal(b.shouldAttempt(1000), true, "after cooldown: half-open probe allowed");
  });

  test.it("a success closes the breaker and resets the failure run", () => {
    const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    b.onFailure(0);
    b.onFailure(0); // open
    assert.equal(b.shouldAttempt(0), false);
    b.onSuccess();
    assert.equal(b.shouldAttempt(0), true, "success closes it");
    b.onFailure(0); // run was reset, so one failure must not reopen (threshold 2)
    assert.equal(b.shouldAttempt(0), true, "failure run reset by the success");
  });

  test.it("a half-open probe failure re-opens for another cooldown", () => {
    const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.onFailure(0); // threshold 1 → open until 1000
    assert.equal(b.shouldAttempt(1000), true, "half-open probe allowed after cooldown");
    b.onFailure(1000); // probe fails → reopen until 2000
    assert.equal(b.shouldAttempt(1000), false);
    assert.equal(b.shouldAttempt(2000), true);
  });

  test.it("rejects an invalid threshold", () => {
    assert.throws(() => createCircuitBreaker({ failureThreshold: 0, cooldownMs: 1000 }));
  });
});
