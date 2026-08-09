/**
 * test-due-starvation.ts — F-3.6a.
 *
 * The starvation fixture. Hermetic; no DB, no network.
 *
 * THE PRODUCTION STATE THIS REPRODUCES (F-D4, 2026-08-09)
 *
 * The due query selects `queued AND scheduled_at <= now AND replied = 0 AND
 * followup_paused = false`, orders by scheduled_at ascending, takes 20.
 * Admin-paused users were filtered NOWHERE in that query — only inside the
 * processing loop, by a `continue`.
 *
 * User 8 was admin-paused. Her fifteen queued rows, scheduled 2026-07-30 to
 * 08-03, were the fifteen OLDEST eligible rows in the entire system. Every
 * tick selected them and skipped them. Five slots of twenty did real work,
 * for ever, and everything behind them starved.
 *
 * The fixture below is that state, at the same scale. It asserts the
 * starvation exists under the old rules and is gone under the new ones, so
 * the fix is demonstrated rather than asserted.
 *
 * `excludeHeldUsers: false` reproduces the pre-F-3.6a SELECT against the same
 * single implementation — there is no second copy of the rules to drift.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-due-starvation.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  selectDueBatch,
  batchUtilisation,
  isDueRowEligible,
  isUserHeld,
  isProcessableInLoop,
  DUE_BATCH_LIMIT,
  type DueCandidate,
} from "../lib/dueEligibility";

const NOW = new Date("2026-08-09T14:50:00.000Z");

let nextId = 1;
function row(over: Partial<DueCandidate> = {}): DueCandidate {
  return {
    followupId: nextId++,
    status: "queued",
    scheduledAt: new Date("2026-08-07T17:00:00.000Z"),
    prospectReplied: 0,
    prospectApp: "doctrine",
    prospectPaused: false,
    userId: 13,
    userPausedByAdmin: false,
    userAuthDead: false,
    ...over,
  };
}

/**
 * The 2026-08-09 queue, to scale:
 *   - 15 rows for admin-paused user 8, scheduled 07-30 → 08-03 (the OLDEST);
 *   - 5 rows for user 7 whose prospects are cascade-paused (these were
 *     already excluded by the pre-existing followup_paused filter);
 *   - 159 healthy rows scheduled 08-07/08-08, behind all of them.
 */
function productionShapedQueue(): DueCandidate[] {
  nextId = 1;
  const rows: DueCandidate[] = [];

  for (let i = 0; i < 15; i++) {
    rows.push(row({
      userId: 8,
      userPausedByAdmin: true,
      scheduledAt: new Date(Date.UTC(2026, 6, 30, 8 + i, 0, 0)),
    }));
  }
  for (let i = 0; i < 5; i++) {
    rows.push(row({
      userId: 7,
      prospectPaused: true,
      scheduledAt: new Date(Date.UTC(2026, 6, 31, 8 + i, 0, 0)),
    }));
  }
  for (let i = 0; i < 159; i++) {
    rows.push(row({
      userId: 13,
      scheduledAt: new Date(Date.UTC(2026, 7, 7, 17, i, 0)),
    }));
  }
  return rows;
}

test.describe("the starvation, reproduced under the pre-F-3.6a rules", () => {
  test.it("selects 20 rows of which only 5 are real work — 15 wasted, every tick", () => {
    const batch = selectDueBatch(productionShapedQueue(), NOW, DUE_BATCH_LIMIT, {
      excludeHeldUsers: false,
    });

    const util = batchUtilisation(batch);
    assert.equal(util.selected, 20, "the batch is full");
    assert.equal(util.wasted, 15, "15 of 20 slots go to rows the loop will skip");
    assert.equal(util.processable, 5, "only 5 slots do anything");
  });

  test.it("the wasted slots are the SAME rows on every consecutive tick — it never drains", () => {
    const queue = productionShapedQueue();
    const first = selectDueBatch(queue, NOW, DUE_BATCH_LIMIT, { excludeHeldUsers: false });
    const later = selectDueBatch(queue, new Date(NOW.getTime() + 3 * 60_000), DUE_BATCH_LIMIT, {
      excludeHeldUsers: false,
    });

    const heldFirst = first.filter((r) => !isProcessableInLoop(r)).map((r) => r.followupId);
    const heldLater = later.filter((r) => !isProcessableInLoop(r)).map((r) => r.followupId);
    assert.deepEqual(heldLater, heldFirst, "the same 15 rows are re-selected and re-skipped for ever");
    assert.equal(heldFirst.length, 15);
  });

  test.it("the throughput cost: 75% of every pass is thrown away", () => {
    const util = batchUtilisation(
      selectDueBatch(productionShapedQueue(), NOW, DUE_BATCH_LIMIT, { excludeHeldUsers: false }),
    );
    assert.equal(util.wasted / util.selected, 0.75);
  });
});

test.describe("the fix", () => {
  test.it("selects 20 rows of which 20 are real work — nothing wasted", () => {
    const util = batchUtilisation(selectDueBatch(productionShapedQueue(), NOW, DUE_BATCH_LIMIT));
    assert.equal(util.selected, 20);
    assert.equal(util.wasted, 0, "no slot is spent on a row the loop will skip");
    assert.equal(util.processable, 20);
  });

  test.it("the batch is now made of the rows that were starved behind the block", () => {
    const batch = selectDueBatch(productionShapedQueue(), NOW, DUE_BATCH_LIMIT);
    assert.ok(batch.every((r) => r.userId === 13), "the healthy user's backlog finally gets the slots");
  });

  test.it("held rows are still QUEUED, not cancelled — they resume when the hold lifts", () => {
    const queue = productionShapedQueue();
    const heldRows = queue.filter((r) => r.userPausedByAdmin);
    assert.equal(heldRows.length, 15);
    assert.ok(heldRows.every((r) => r.status === "queued"), "nothing is destroyed by excluding it");

    // Unpause the account: the same rows become eligible again, oldest-first.
    const resumed = queue.map((r) => (r.userPausedByAdmin ? { ...r, userPausedByAdmin: false } : r));
    const batch = selectDueBatch(resumed, NOW, DUE_BATCH_LIMIT);
    assert.equal(batch.filter((r) => r.userId === 8).length, 15, "they come straight back on resume");
  });

  test.it("ordering is unchanged: still oldest-scheduled first", () => {
    const batch = selectDueBatch(productionShapedQueue(), NOW, DUE_BATCH_LIMIT);
    for (let i = 1; i < batch.length; i++) {
      assert.ok(
        batch[i - 1].scheduledAt.getTime() <= batch[i].scheduledAt.getTime(),
        "the fix must not reorder the queue",
      );
    }
  });

  test.it("batch size is unchanged at 20", () => {
    assert.equal(DUE_BATCH_LIMIT, 20);
  });
});

test.describe("auth-dead users are excluded the same way", () => {
  test.it("an auth-dead account's rows never reach the batch", () => {
    nextId = 1;
    const queue = [
      ...Array.from({ length: 15 }, (_, i) =>
        row({ userId: 5, userAuthDead: true, scheduledAt: new Date(Date.UTC(2026, 7, 1, i)) })),
      ...Array.from({ length: 10 }, (_, i) =>
        row({ userId: 7, scheduledAt: new Date(Date.UTC(2026, 7, 7, i)) })),
    ];

    const util = batchUtilisation(selectDueBatch(queue, NOW, DUE_BATCH_LIMIT));
    assert.equal(util.wasted, 0);
    assert.equal(util.selected, 10, "only the healthy account's rows remain");
  });

  test.it("before the fix they were selected AND generated — worse than skipped", () => {
    nextId = 1;
    const queue = Array.from({ length: 15 }, () => row({ userId: 5, userAuthDead: true }));
    const old = selectDueBatch(queue, NOW, DUE_BATCH_LIMIT, { excludeHeldUsers: false });
    assert.equal(old.length, 15, "the old rules handed every one of these to the generator");
  });
});

test.describe("what must NOT change", () => {
  test.it("legacy rows with a null user_id still process — an INNER JOIN would have dropped them", () => {
    nextId = 1;
    const legacy = row({ userId: null, userPausedByAdmin: false, userAuthDead: false });
    assert.equal(isUserHeld(legacy), false);
    assert.equal(isDueRowEligible(legacy, NOW), true);
    assert.equal(selectDueBatch([legacy], NOW).length, 1);
  });

  test.it("a legacy row survives even beside held rows in the same batch", () => {
    nextId = 1;
    const queue = [
      row({ userId: 8, userPausedByAdmin: true, scheduledAt: new Date(Date.UTC(2026, 6, 30)) }),
      row({ userId: null, scheduledAt: new Date(Date.UTC(2026, 6, 31)) }),
    ];
    const batch = selectDueBatch(queue, NOW);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].userId, null);
  });

  test.it("a future-scheduled row is still not due", () => {
    assert.equal(isDueRowEligible(row({ scheduledAt: new Date("2026-08-20T09:00:00Z") }), NOW), false);
  });

  test.it("a row scheduled exactly now IS due", () => {
    assert.equal(isDueRowEligible(row({ scheduledAt: NOW }), NOW), true);
  });

  test.it("a non-queued row is never due", () => {
    for (const status of ["sent", "generating", "failed", "cancelled", "drafted", "pending_approval"]) {
      assert.equal(isDueRowEligible(row({ status }), NOW), false, status);
    }
  });

  test.it("a paused prospect is still excluded", () => {
    assert.equal(isDueRowEligible(row({ prospectPaused: true }), NOW), false);
  });

  test.it("a replied prospect is still excluded", () => {
    assert.equal(isDueRowEligible(row({ prospectReplied: 1 }), NOW), false);
  });

  test.it("B9b.12.5 preserved: a replied anti_ghosting prospect is still eligible", () => {
    assert.equal(
      isDueRowEligible(row({ prospectReplied: 1, prospectApp: "anti_ghosting" }), NOW),
      true,
    );
  });

  test.it("but a PAUSED anti_ghosting prospect is still excluded — pause stays universal", () => {
    assert.equal(
      isDueRowEligible(row({ prospectReplied: 1, prospectApp: "anti_ghosting", prospectPaused: true }), NOW),
      false,
    );
  });
});

/* ── MUTATION PROOF ───────────────────────────────────────────────────────
 *
 * Reintroducing the defect must make this file fail. The `excludeHeldUsers`
 * option IS the defect, expressed as a parameter, so the proof is executable
 * rather than a claim in a comment: the block below runs both the fixed and
 * the broken rules over the same fixture and asserts they DISAGREE.
 *
 * If someone deletes the held-user condition from the query in scheduler.ts,
 * `isDueRowEligible` stops distinguishing the two modes, this test's two
 * sides converge, and it fails.
 *
 * Verified by mutation on 2026-08-09, against this file (21 cases, all green
 * unmutated):
 *
 *   1. force `excludeHeld = false` in isDueRowEligible — i.e. delete the
 *      held-user exclusion, restoring the pre-F-3.6a SELECT  →  5 FAIL
 *   2. make isUserHeld return `userPausedByAdmin` only, dropping the
 *      auth-dead half                                        →  2 FAIL
 *   3. make isUserHeld return true for a null user_id — i.e. the INNER JOIN
 *      that would silently drop every legacy row             →  3 FAIL
 *
 * Each mutation was reverted immediately and the suite returned to 21/21.
 */
test.describe("mutation proof — the fix is load-bearing", () => {
  test.it("fixed and broken rules produce materially different batches", () => {
    const queue = productionShapedQueue();
    const fixed = batchUtilisation(selectDueBatch(queue, NOW, DUE_BATCH_LIMIT));
    const broken = batchUtilisation(
      selectDueBatch(queue, NOW, DUE_BATCH_LIMIT, { excludeHeldUsers: false }),
    );

    assert.notEqual(
      fixed.wasted,
      broken.wasted,
      "if these are equal the held-user exclusion has been removed and the starvation is back",
    );
    assert.equal(fixed.wasted, 0);
    assert.equal(broken.wasted, 15);
  });

  test.it("isUserHeld is what the SQL must encode — both halves of it", () => {
    assert.equal(isUserHeld({ userId: 8, userPausedByAdmin: true, userAuthDead: false }), true);
    assert.equal(isUserHeld({ userId: 5, userPausedByAdmin: false, userAuthDead: true }), true);
    assert.equal(isUserHeld({ userId: 7, userPausedByAdmin: false, userAuthDead: false }), false);
    assert.equal(isUserHeld({ userId: null, userPausedByAdmin: true, userAuthDead: true }), false);
  });
});
