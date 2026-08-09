/**
 * test-failed-retry-policy.ts — F-3.6a.
 *
 * Hermetic tests for the bounded retry policy that replaced the 15-minute
 * amnesia revive. No DB, no network.
 *
 * What these lock:
 *   - a failed row gets at most MAX_AUTO_RETRIES automatic attempts, then
 *     STAYS failed and visible. Silence was the bug.
 *   - a row whose owner's grant is auth-dead is not retried AT ALL, and does
 *     not burn a strike while it waits. That loop cost 196 unsendable
 *     follow-ups and 75% of a week's LLM spend (F-D4, 2026-08-09).
 *   - a `stranded` row is never auto-retried, at any retry count, ever —
 *     RH-1's rule, preserved: it may already have been delivered.
 *   - the error history survives, oldest-first, capped, and tolerant of a
 *     malformed jsonb column.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-failed-retry-policy.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  decideFailedRowAction,
  classifyProcessingFailure,
  appendFailure,
  makeFailureRecord,
  MAX_AUTO_RETRIES,
  MAX_ERROR_HISTORY,
  MAX_ERROR_TEXT,
} from "../lib/retryPolicy";

const NOW = new Date("2026-08-09T14:00:00.000Z");

test.describe("classifyProcessingFailure — the duplicate-send window", () => {
  test.it("a plain failure before any Gmail call is a retryable send error", () => {
    assert.equal(
      classifyProcessingFailure({ gmailArtifactId: null, isAuthFailure: false }),
      "send_error",
    );
  });

  test.it("a refused grant before any Gmail call is auth_dead", () => {
    assert.equal(
      classifyProcessingFailure({ gmailArtifactId: null, isAuthFailure: true }),
      "auth_dead",
    );
  });

  test.it("DUPLICATE GUARD: a failure AFTER the send succeeded is stranded, never retried", () => {
    // The email is already in the client's inbox and only the status write
    // failed. Retrying delivers a second copy.
    assert.equal(
      classifyProcessingFailure({ gmailArtifactId: "18f0abc", isAuthFailure: false }),
      "stranded",
    );
    assert.equal(
      decideFailedRowAction({ retryCount: 0, failureReason: "stranded", ownerAuthDead: false }).action,
      "hold",
    );
  });

  test.it("delivery outranks an auth error — a duplicate is worse than a wasted generation", () => {
    assert.equal(
      classifyProcessingFailure({ gmailArtifactId: "18f0abc", isAuthFailure: true }),
      "stranded",
    );
  });

  test.it("treats an empty or missing artifact id as 'nothing was delivered'", () => {
    assert.equal(classifyProcessingFailure({ gmailArtifactId: "", isAuthFailure: false }), "send_error");
    assert.equal(classifyProcessingFailure({ gmailArtifactId: undefined, isAuthFailure: false }), "send_error");
  });

  test.it("end to end: delivered-but-unrecorded can never be auto-resent", () => {
    const reason = classifyProcessingFailure({ gmailArtifactId: "18f0abc", isAuthFailure: false });
    for (let tick = 0; tick < 96; tick++) {
      assert.equal(
        decideFailedRowAction({ retryCount: tick, failureReason: reason, ownerAuthDead: false }).action,
        "hold",
      );
    }
  });
});

test.describe("decideFailedRowAction — the retry budget", () => {
  test.it("a fresh failure retries and spends its first strike", () => {
    const d = decideFailedRowAction({ retryCount: 0, failureReason: "send_error", ownerAuthDead: false });
    assert.deepEqual(d, { action: "retry", nextRetryCount: 1 });
  });

  test.it("a once-retried failure retries and spends its second", () => {
    const d = decideFailedRowAction({ retryCount: 1, failureReason: "send_error", ownerAuthDead: false });
    assert.deepEqual(d, { action: "retry", nextRetryCount: 2 });
  });

  test.it("at the cap it HOLDS — the row stays failed and visible", () => {
    const d = decideFailedRowAction({ retryCount: MAX_AUTO_RETRIES, failureReason: "send_error", ownerAuthDead: false });
    assert.deepEqual(d, { action: "hold", reason: "retries_exhausted" });
  });

  test.it("past the cap (hand-edited or legacy data) still holds", () => {
    const d = decideFailedRowAction({ retryCount: 99, failureReason: "send_error", ownerAuthDead: false });
    assert.equal(d.action, "hold");
  });

  test.it("the budget is exactly two automatic attempts, not more", () => {
    assert.equal(MAX_AUTO_RETRIES, 2);
    let count = 0;
    let retries = 0;
    for (let i = 0; i < 10; i++) {
      const d = decideFailedRowAction({ retryCount: retries, failureReason: "send_error", ownerAuthDead: false });
      if (d.action === "hold") break;
      retries = d.nextRetryCount;
      count++;
    }
    assert.equal(count, 2, "the loop must terminate after two automatic retries");
  });

  test.it("an unclassified failure (null reason) is treated as a normal send error", () => {
    assert.deepEqual(
      decideFailedRowAction({ retryCount: 0, failureReason: null, ownerAuthDead: false }),
      { action: "retry", nextRetryCount: 1 },
    );
    assert.equal(
      decideFailedRowAction({ retryCount: 2, failureReason: undefined, ownerAuthDead: false }).action,
      "hold",
    );
  });
});

test.describe("decideFailedRowAction — no retry while the grant is dead", () => {
  test.it("holds for auth_dead regardless of retry count", () => {
    for (const retryCount of [0, 1, 2, 5]) {
      const d = decideFailedRowAction({ retryCount, failureReason: "auth_dead", ownerAuthDead: true });
      assert.deepEqual(d, { action: "hold", reason: "auth_dead" }, `retryCount=${retryCount}`);
    }
  });

  test.it("holds even when the row's own failure was something else", () => {
    const d = decideFailedRowAction({ retryCount: 0, failureReason: "send_error", ownerAuthDead: true });
    assert.deepEqual(d, { action: "hold", reason: "auth_dead" });
  });

  test.it("THE BURN LOOP: a dead grant can never drive an unbounded retry cycle", () => {
    // Before F-3.6a this shape regenerated every hour, for ever, at full LLM
    // cost, wiping its own evidence each time.
    let retries = 0;
    for (let i = 0; i < 100; i++) {
      const d = decideFailedRowAction({ retryCount: retries, failureReason: "auth_dead", ownerAuthDead: true });
      assert.equal(d.action, "hold");
      if (d.action === "hold") break;
    }
  });

  test.it("once the grant heals, the row retries WITHOUT having spent a strike", () => {
    // The row did nothing wrong; its owner's token did. Charging it retries
    // would silently drop follow-ups that waited out a dead-grant window.
    const d = decideFailedRowAction({ retryCount: 0, failureReason: "auth_dead", ownerAuthDead: false });
    assert.deepEqual(d, { action: "retry", nextRetryCount: 0 });
  });

  test.it("a healed grant retries a row that already had two auth_dead attempts", () => {
    const d = decideFailedRowAction({ retryCount: 2, failureReason: "auth_dead", ownerAuthDead: false });
    assert.equal(d.action, "retry", "auth-dead attempts must not exhaust the budget");
  });

  test.it("a negative stored retryCount is clamped, never negative-indexed", () => {
    const d = decideFailedRowAction({ retryCount: -3, failureReason: "auth_dead", ownerAuthDead: false });
    assert.deepEqual(d, { action: "retry", nextRetryCount: 0 });
  });
});

test.describe("decideFailedRowAction — stranded is terminal (RH-1's rule)", () => {
  test.it("never auto-retries, at any retry count", () => {
    for (const retryCount of [0, 1, 2, 7]) {
      const d = decideFailedRowAction({ retryCount, failureReason: "stranded", ownerAuthDead: false });
      assert.deepEqual(d, { action: "hold", reason: "stranded_needs_human" }, `retryCount=${retryCount}`);
    }
  });

  test.it("stranded is checked BEFORE auth-dead, so the reason reported is the specific one", () => {
    const d = decideFailedRowAction({ retryCount: 0, failureReason: "stranded", ownerAuthDead: true });
    assert.deepEqual(d, { action: "hold", reason: "stranded_needs_human" });
  });

  test.it("DOUBLE-SEND GUARD: no input combination makes a stranded row auto-retry", () => {
    // A row can strand AFTER the Gmail send and BEFORE the status write.
    // Auto-retrying it puts a second copy of the same email in a client's
    // inbox. This assertion is the one that must never be relaxed.
    for (const retryCount of [0, 1, 2, 3]) {
      for (const ownerAuthDead of [true, false]) {
        assert.equal(
          decideFailedRowAction({ retryCount, failureReason: "stranded", ownerAuthDead }).action,
          "hold",
        );
      }
    }
  });
});

test.describe("makeFailureRecord / appendFailure — the evidence", () => {
  test.it("records the instant, reason, error and attempt number", () => {
    const r = makeFailureRecord({ reason: "send_error", error: "boom", attempt: 1, now: NOW });
    assert.deepEqual(r, {
      at: "2026-08-09T14:00:00.000Z",
      reason: "send_error",
      error: "boom",
      attempt: 1,
    });
  });

  test.it("truncates a huge provider error rather than storing it whole", () => {
    const r = makeFailureRecord({ reason: "send_error", error: "x".repeat(5000), attempt: 0, now: NOW });
    assert.equal(r.error.length, MAX_ERROR_TEXT);
    assert.ok(r.error.endsWith("…"));
  });

  test.it("clamps a nonsense attempt number", () => {
    assert.equal(makeFailureRecord({ reason: "x", error: "y", attempt: -5, now: NOW }).attempt, 0);
    assert.equal(makeFailureRecord({ reason: "x", error: "y", attempt: 2.7, now: NOW }).attempt, 2);
  });

  test.it("appends oldest-first onto an empty history", () => {
    const rec = makeFailureRecord({ reason: "send_error", error: "first", attempt: 0, now: NOW });
    assert.deepEqual(appendFailure(null, rec), [rec]);
    assert.deepEqual(appendFailure(undefined, rec), [rec]);
    assert.deepEqual(appendFailure([], rec), [rec]);
  });

  test.it("preserves prior entries in order", () => {
    const a = makeFailureRecord({ reason: "send_error", error: "one", attempt: 0, now: NOW });
    const b = makeFailureRecord({ reason: "send_error", error: "two", attempt: 1, now: NOW });
    const out = appendFailure(appendFailure(null, a), b);
    assert.deepEqual(out.map((r) => r.error), ["one", "two"]);
  });

  test.it("caps at MAX_ERROR_HISTORY, dropping the OLDEST", () => {
    let history = appendFailure(null, makeFailureRecord({ reason: "r", error: "e0", attempt: 0, now: NOW }));
    for (let i = 1; i < MAX_ERROR_HISTORY + 5; i++) {
      history = appendFailure(history, makeFailureRecord({ reason: "r", error: `e${i}`, attempt: i, now: NOW }));
    }
    assert.equal(history.length, MAX_ERROR_HISTORY);
    assert.equal(history[history.length - 1].error, `e${MAX_ERROR_HISTORY + 4}`, "newest kept");
    assert.ok(!history.some((r) => r.error === "e0"), "oldest dropped");
  });

  test.it("an unbounded failure loop cannot grow the column without limit", () => {
    let history: unknown = null;
    for (let i = 0; i < 1000; i++) {
      history = appendFailure(history, makeFailureRecord({ reason: "r", error: "e", attempt: i, now: NOW }));
    }
    assert.equal((history as unknown[]).length, MAX_ERROR_HISTORY);
  });

  test.it("a malformed jsonb column is replaced, never thrown on", () => {
    const rec = makeFailureRecord({ reason: "r", error: "e", attempt: 0, now: NOW });
    // A hand-written UPDATE could have put anything in this column. Losing
    // stale history beats a cron tick that dies mid-pass.
    assert.deepEqual(appendFailure({ not: "an array" }, rec), [rec]);
    assert.deepEqual(appendFailure("a string", rec), [rec]);
    assert.deepEqual(appendFailure(42, rec), [rec]);
  });

  test.it("honours an explicit cap", () => {
    let history = appendFailure(null, makeFailureRecord({ reason: "r", error: "a", attempt: 0, now: NOW }), 2);
    history = appendFailure(history, makeFailureRecord({ reason: "r", error: "b", attempt: 1, now: NOW }), 2);
    history = appendFailure(history, makeFailureRecord({ reason: "r", error: "c", attempt: 2, now: NOW }), 2);
    assert.deepEqual(history.map((r) => r.error), ["b", "c"]);
  });

  test.it("a zero or negative cap still keeps the newest entry", () => {
    const rec = makeFailureRecord({ reason: "r", error: "keep", attempt: 0, now: NOW });
    assert.deepEqual(appendFailure([], rec, 0).map((r) => r.error), ["keep"]);
    assert.deepEqual(appendFailure([], rec, -1).map((r) => r.error), ["keep"]);
  });
});

test.describe("end-to-end: a failing row's life", () => {
  test.it("two retries, then held, with all three failures on the row", () => {
    let retryCount = 0;
    let history: unknown = null;
    let attempts = 0;

    for (let tick = 0; tick < 10; tick++) {
      // The send fails.
      attempts++;
      const decision = decideFailedRowAction({
        retryCount,
        failureReason: "send_error",
        ownerAuthDead: false,
      });
      if (decision.action === "hold") {
        assert.equal(decision.reason, "retries_exhausted");
        break;
      }
      history = appendFailure(
        history,
        makeFailureRecord({ reason: "send_error", error: `attempt ${retryCount}`, attempt: retryCount, now: NOW }),
      );
      retryCount = decision.nextRetryCount;
    }

    assert.equal(attempts, 3, "one original attempt plus two retries");
    assert.equal(retryCount, MAX_AUTO_RETRIES);
    assert.equal((history as unknown[]).length, 2, "each retry preserved the failure it replaced");
  });
});
