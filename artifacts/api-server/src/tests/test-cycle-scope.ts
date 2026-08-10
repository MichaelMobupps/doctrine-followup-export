/**
 * test-cycle-scope.ts — F-3.6b.
 *
 * The AntiGhosting renewal regression. Hermetic; no DB, no network.
 *
 * THE DEFECT THIS REPRODUCES
 *
 * B9a moved the unique constraint on `followups` from `(prospect_id, stage)`
 * to `(prospect_id, cycle, stage)` so a renewed AntiGhosting campaign can
 * re-use stage numbers 1..3 under a new cycle. The queueing path never
 * followed: `queueStageForProspect` looked up `(prospect_id, stage)` with
 * `.limit(1)` and inserted without a cycle, and `autoQueueAllCampaigns`
 * counted sent stages across every cycle.
 *
 * `cycleScoped: false` reproduces the pre-F-3.6b behaviour against the SAME
 * implementation, so the strand is demonstrated rather than asserted — the
 * pattern `dueEligibility.ts` established with `excludeHeldUsers`.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-cycle-scope.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  rowsInCycle,
  findStageRow,
  campaignPosition,
  type StageRow,
} from "../lib/cycleScope";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-07-01T09:00:00Z");

function sent(id: number, cycle: number, stage: number, dayOffset: number): StageRow {
  return { id, cycle, stage, status: "sent", sentAt: new Date(T0.getTime() + dayOffset * DAY) };
}
function queued(id: number, cycle: number, stage: number): StageRow {
  return { id, cycle, stage, status: "queued", sentAt: null };
}
function cancelled(id: number, cycle: number, stage: number): StageRow {
  return { id, cycle, stage, status: "cancelled", sentAt: null };
}

/**
 * The production shape: an AntiGhosting prospect whose first cycle ran to
 * completion (three stages sent) and which the operator has since renewed, so
 * `prospects.cycle` is 2 and no cycle-2 row exists yet.
 */
const RENEWED_AG: StageRow[] = [
  sent(101, 1, 1, 0),
  sent(102, 1, 2, 7),
  sent(103, 1, 3, 14),
];

/** A doctrine campaign: everything is cycle 1, for ever. */
const DOCTRINE: StageRow[] = [
  sent(201, 1, 1, 0),
  sent(202, 1, 2, 4),
];

// ---------------------------------------------------------------------------
// A. THE STRAND — the lookup queueStageForProspect performs
// ---------------------------------------------------------------------------
test.describe("findStageRow — the (cycle, stage) lookup", () => {
  test.it(
    "OLD BEHAVIOUR: cycle-2 stage 1 finds the SENT cycle-1 row, and the stage is never queued",
    () => {
      const found = findStageRow(RENEWED_AG, 2, 1, { cycleScoped: false });
      assert.ok(found, "the unscoped lookup returns a row");
      assert.equal(found!.cycle, 1, "and it belongs to the PREVIOUS cycle");
      assert.equal(found!.status, "sent");
      // This is the strand: queueStageForProspect sees `sent` and returns
      // {queued: false, revived: false}. The renewed campaign never starts.
    },
  );

  test.it("NEW BEHAVIOUR: cycle-2 stage 1 finds nothing, so the row is INSERTED", () => {
    const found = findStageRow(RENEWED_AG, 2, 1);
    assert.equal(found, undefined);
  });

  test.it("a cycle-2 row that does exist is found, and the cycle-1 row is not", () => {
    const rows = [...RENEWED_AG, queued(104, 2, 1)];
    const found = findStageRow(rows, 2, 1);
    assert.equal(found?.id, 104);
    assert.equal(found?.cycle, 2);
  });

  test.it("a cancelled cycle-2 row is found so it can be revived in place", () => {
    const rows = [...RENEWED_AG, cancelled(105, 2, 2)];
    const found = findStageRow(rows, 2, 2);
    assert.equal(found?.id, 105);
    assert.equal(found?.status, "cancelled");
  });

  test.it("doctrine is unaffected: scoped and unscoped agree on every stage", () => {
    for (const stage of [1, 2, 3]) {
      assert.deepEqual(
        findStageRow(DOCTRINE, 1, stage),
        findStageRow(DOCTRINE, 1, stage, { cycleScoped: false }),
        `stage ${stage}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// B. THE SECOND HALF — where the stage number comes from
// ---------------------------------------------------------------------------
test.describe("campaignPosition — the auto-queue sweep's stage counter", () => {
  test.it(
    "OLD BEHAVIOUR: a renewed campaign inherits the finished cycle's stage count",
    () => {
      const p = campaignPosition(RENEWED_AG, 2, { cycleScoped: false });
      assert.equal(p.maxSentStage, 3, "counts cycle 1's three sent stages");
      assert.equal(p.nextStage, 4);
      // The AG business rule is 3 stages per cycle and the user cap is 3, so
      // nextStage 4 is rejected by the cap and the prospect is skipped on
      // every tick, silently, for ever.
      assert.ok(p.nextStage > 3, "and is then rejected by the follow-up cap");
    },
  );

  test.it("NEW BEHAVIOUR: a renewed campaign starts again at stage 1", () => {
    const p = campaignPosition(RENEWED_AG, 2);
    assert.equal(p.maxSentStage, 0);
    assert.equal(p.nextStage, 1);
    assert.equal(p.lastSentAt, null);
    assert.equal(p.hasActive, false);
  });

  test.it(
    "OLD BEHAVIOUR: cycle 1's rows also make the renewed campaign look busy when one is active",
    () => {
      const rows = [...RENEWED_AG, queued(106, 1, 4)];
      assert.equal(campaignPosition(rows, 2, { cycleScoped: false }).hasActive, true);
      assert.equal(campaignPosition(rows, 2).hasActive, false, "scoped: cycle 2 has nothing in flight");
    },
  );

  test.it("an active row IN THIS CYCLE still blocks, as it must", () => {
    const rows = [...RENEWED_AG, queued(107, 2, 1)];
    assert.equal(campaignPosition(rows, 2).hasActive, true);
  });

  test.it("each of the four active statuses blocks", () => {
    for (const status of ["queued", "generating", "pending_approval", "drafted"]) {
      const rows: StageRow[] = [{ id: 1, cycle: 2, stage: 1, status, sentAt: null }];
      assert.equal(campaignPosition(rows, 2).hasActive, true, status);
    }
  });

  test.it("failed and cancelled rows do NOT block — that is what revival is for", () => {
    for (const status of ["failed", "cancelled", "sent", "stalled_awaiting_manual_send"]) {
      const rows: StageRow[] = [{ id: 1, cycle: 2, stage: 1, status, sentAt: null }];
      assert.equal(campaignPosition(rows, 2).hasActive, false, status);
    }
  });

  test.it("mid-cycle: two sent in cycle 2 means stage 3 next, ignoring cycle 1 entirely", () => {
    const rows = [...RENEWED_AG, sent(108, 2, 1, 30), sent(109, 2, 2, 37)];
    const p = campaignPosition(rows, 2);
    assert.equal(p.maxSentStage, 2);
    assert.equal(p.nextStage, 3);
    assert.equal(p.lastSentAt?.toISOString(), new Date(T0.getTime() + 37 * DAY).toISOString());
  });

  test.it("lastSentAt tracks the highest STAGE, not the latest timestamp", () => {
    // A stage-2 row re-sent after stage 3 must not become the anchor: the
    // timing engine schedules from the last stage in the sequence.
    const rows = [sent(1, 1, 1, 0), sent(2, 1, 3, 5), sent(3, 1, 2, 40)];
    const p = campaignPosition(rows, 1);
    assert.equal(p.maxSentStage, 3);
    assert.equal(p.lastSentAt?.toISOString(), new Date(T0.getTime() + 5 * DAY).toISOString());
  });

  test.it("doctrine is unaffected: scoped and unscoped agree", () => {
    assert.deepEqual(campaignPosition(DOCTRINE, 1), campaignPosition(DOCTRINE, 1, { cycleScoped: false }));
    assert.equal(campaignPosition(DOCTRINE, 1).nextStage, 3);
  });

  test.it("a prospect with no follow-ups at all starts at stage 1 in any cycle", () => {
    for (const cycle of [1, 2, 5]) {
      const p = campaignPosition([], cycle);
      assert.equal(p.nextStage, 1, `cycle ${cycle}`);
      assert.equal(p.hasActive, false);
    }
  });
});

// ---------------------------------------------------------------------------
// C. the scope itself
// ---------------------------------------------------------------------------
test.describe("rowsInCycle", () => {
  test.it("scoped returns only the requested cycle", () => {
    const rows = [...RENEWED_AG, queued(110, 2, 1), queued(111, 3, 1)];
    assert.deepEqual(rowsInCycle(rows, 2).map((r) => r.id), [110]);
  });

  test.it("unscoped returns everything — the old behaviour, unchanged", () => {
    const rows = [...RENEWED_AG, queued(110, 2, 1)];
    assert.equal(rowsInCycle(rows, 2, { cycleScoped: false }).length, rows.length);
  });

  test.it("does not mutate or alias the caller's array", () => {
    const rows = [...RENEWED_AG];
    const out = rowsInCycle(rows, 2, { cycleScoped: false });
    out.pop();
    assert.equal(rows.length, 3);
  });

  test.it("a cycle nobody has reached yet is empty, not everything", () => {
    assert.deepEqual(rowsInCycle(RENEWED_AG, 9), []);
  });
});
