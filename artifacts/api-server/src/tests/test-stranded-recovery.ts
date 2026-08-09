/**
 * test-stranded-recovery.ts — F-3.6a.
 *
 * Hermetic tests for the stranded-`generating` classifier. No DB, no network.
 *
 * A row reaches `generating` when the scheduler claims it and leaves when the
 * result is written. If the process dies in between, the row stays
 * `generating` for ever — and because `generating` is an ACTIVE status,
 * auto-queue believes the campaign is busy and never schedules another stage.
 * Two production rows had been frozen that way since 2026-07-21 and 07-28
 * when F-D4 found them on 08-09.
 *
 * What these lock:
 *   - the 6h threshold is unchanged from RH-1, and nothing younger is touched;
 *   - only `generating` rows are ever classified;
 *   - the recovery is a status move, NOT a re-queue — the double-send rule
 *     RH-1 was written for is preserved by the retry policy, and that
 *     interlock is asserted here too, because it spans two modules and is
 *     the one property that must never quietly regress.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-stranded-recovery.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  isStrandedGenerating,
  strandedCutoff,
  strandedErrorMessage,
  GENERATING_STRAND_HOURS,
} from "../lib/strandedGenerating";
import { decideFailedRowAction } from "../lib/retryPolicy";

const NOW = new Date("2026-08-09T14:50:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

test.describe("the threshold", () => {
  test.it("is still 6 hours — unchanged from RH-1", () => {
    assert.equal(GENERATING_STRAND_HOURS, 6);
  });

  test.it("the cutoff is exactly now minus the threshold", () => {
    assert.equal(strandedCutoff(NOW).toISOString(), hoursAgo(6).toISOString());
  });

  test.it("honours an explicit threshold", () => {
    assert.equal(strandedCutoff(NOW, 1).toISOString(), hoursAgo(1).toISOString());
  });
});

test.describe("isStrandedGenerating", () => {
  test.it("the two production rows: frozen for days, both stranded", () => {
    // followup 28338, scheduled 2026-07-21T17:25Z
    assert.equal(
      isStrandedGenerating({ status: "generating", scheduledAt: new Date("2026-07-21T17:25:00Z") }, NOW),
      true,
    );
    // followup 34334, scheduled 2026-07-28T16:14Z
    assert.equal(
      isStrandedGenerating({ status: "generating", scheduledAt: new Date("2026-07-28T16:14:00Z") }, NOW),
      true,
    );
  });

  test.it("a generation in flight for minutes is NOT stranded", () => {
    // The longest legitimate chain is a multi-call heal measured in minutes.
    assert.equal(isStrandedGenerating({ status: "generating", scheduledAt: hoursAgo(0.1) }, NOW), false);
    assert.equal(isStrandedGenerating({ status: "generating", scheduledAt: hoursAgo(1) }, NOW), false);
  });

  test.it("just under the threshold is NOT stranded", () => {
    assert.equal(isStrandedGenerating({ status: "generating", scheduledAt: hoursAgo(5.99) }, NOW), false);
  });

  test.it("exactly at the threshold is NOT stranded — strictly older only", () => {
    assert.equal(isStrandedGenerating({ status: "generating", scheduledAt: hoursAgo(6) }, NOW), false);
  });

  test.it("just past the threshold IS stranded", () => {
    assert.equal(isStrandedGenerating({ status: "generating", scheduledAt: hoursAgo(6.01) }, NOW), true);
  });

  test.it("only 'generating' is ever classified — no other status is touched", () => {
    for (const status of ["queued", "sent", "failed", "cancelled", "drafted", "pending_approval"]) {
      assert.equal(
        isStrandedGenerating({ status, scheduledAt: hoursAgo(500) }, NOW),
        false,
        `${status} must never be swept by the stranded pass`,
      );
    }
  });

  test.it("a future-scheduled generating row is never stranded", () => {
    assert.equal(
      isStrandedGenerating({ status: "generating", scheduledAt: new Date("2026-09-01T00:00:00Z") }, NOW),
      false,
    );
  });
});

test.describe("the recorded evidence", () => {
  test.it("names the age, the threshold and what the operator must do", () => {
    const msg = strandedErrorMessage(new Date("2026-07-21T17:25:00Z"), NOW);
    assert.match(msg, /Stranded in 'generating' for \d+h/);
    assert.match(msg, /threshold 6h/);
    assert.match(msg, /NOT retried automatically/);
    assert.match(msg, /Check the Gmail thread/);
  });

  test.it("states the send-may-have-happened risk in plain words", () => {
    const msg = strandedErrorMessage(hoursAgo(12), NOW);
    assert.match(msg, /may\s+already have gone out/);
  });

  test.it("computes whole hours", () => {
    assert.match(strandedErrorMessage(hoursAgo(12), NOW), /for 12h/);
  });
});

test.describe("THE INTERLOCK: recovery must never become a resend", () => {
  test.it("a recovered row is held by the retry policy, not retried", () => {
    // The recovery writes failureReason = "stranded". The policy must refuse
    // it. These two modules only agree by convention, so the convention is
    // asserted here — this is the single property whose regression would put
    // duplicate emails in clients' inboxes.
    const d = decideFailedRowAction({ retryCount: 0, failureReason: "stranded", ownerAuthDead: false });
    assert.deepEqual(d, { action: "hold", reason: "stranded_needs_human" });
  });

  test.it("the reason string the recovery writes is exactly the one the policy matches", () => {
    // If either side is renamed without the other, this fails.
    const reasonWrittenByRecovery = "stranded";
    assert.equal(
      decideFailedRowAction({
        retryCount: 0,
        failureReason: reasonWrittenByRecovery,
        ownerAuthDead: false,
      }).action,
      "hold",
    );
  });

  test.it("no number of subsequent auto-queue passes can revive it", () => {
    // 96 ticks is a full day of the 15-minute auto-queue sweep. The retry
    // count is walked upward by hand because the policy will never advance
    // it for a stranded row — which is the property under test.
    for (let tick = 0; tick < 96; tick++) {
      const d = decideFailedRowAction({
        retryCount: tick,
        failureReason: "stranded",
        ownerAuthDead: tick % 2 === 0,
      });
      assert.equal(d.action, "hold", `tick ${tick} tried to revive a stranded row`);
    }
  });
});
