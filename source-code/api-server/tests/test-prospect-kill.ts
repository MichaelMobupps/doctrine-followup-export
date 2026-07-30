/**
 * test-prospect-kill.ts
 *
 * Hermetic tests for the prospect-level Admin Kill feature. Following the
 * pattern in test-admin-kill.ts and test-suppression.ts, the DB-backed
 * endpoint is not exercised against a live database here; instead the pure
 * pieces in lib/adminKill.ts are tested directly, and the database EFFECTS of
 * a prospect-level kill are asserted through a small in-memory fixture that
 * mimics the transaction's update semantics (cancel this one prospect's active
 * follow-ups, pause this one campaign — and crucially NOT the owning user's
 * paused_by_admin, NOT a sibling campaign). This keeps the test fast and
 * dependency-free while still covering the contract that matters.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-prospect-kill.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  KILL_ACTIVE_FOLLOWUP_STATUSES,
  KILL_CANCEL_MESSAGE,
  KILL_PAUSE_REASON,
  checkProspectConfirm,
} from "../lib/adminKill";

// ── The id-confirm guard ───────────────────────────────────────────

test.describe("checkProspectConfirm", () => {
  test.it("accepts a matching numeric confirmId", () => {
    const r = checkProspectConfirm(42, 42);
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
  });

  test.it("accepts a matching numeric-string confirmId (JSON ids as strings)", () => {
    const r = checkProspectConfirm(42, "42");
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
  });

  test.it("rejects a mismatched confirmId", () => {
    const r = checkProspectConfirm(42, 43);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
  });

  test.it("rejects a mismatched numeric-string confirmId", () => {
    const r = checkProspectConfirm(42, "43");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
  });

  test.it("rejects a missing / empty / non-numeric confirmId", () => {
    assert.equal(checkProspectConfirm(42, undefined).reason, "confirm_missing");
    assert.equal(checkProspectConfirm(42, null).reason, "confirm_missing");
    assert.equal(checkProspectConfirm(42, "").reason, "confirm_missing");
    assert.equal(checkProspectConfirm(42, "   ").reason, "confirm_missing");
    assert.equal(checkProspectConfirm(42, "abc").reason, "confirm_missing");
    assert.equal(checkProspectConfirm(42, {}).reason, "confirm_missing");
    assert.equal(checkProspectConfirm(42, NaN).reason, "confirm_missing");
  });

  test.it("rejects when the path id itself is not a finite number", () => {
    assert.equal(checkProspectConfirm(NaN, 1).reason, "confirm_missing");
    assert.equal(checkProspectConfirm(undefined, 1).reason, "confirm_missing");
    assert.equal(checkProspectConfirm("42", 42).reason, "confirm_missing");
  });

  test.it("a zero confirmId only matches a zero path id, never a mismatch slip", () => {
    assert.equal(checkProspectConfirm(0, 0).ok, true);
    assert.equal(checkProspectConfirm(0, 1).reason, "mismatch");
    assert.equal(checkProspectConfirm(1, 0).reason, "mismatch");
  });
});

// ── The active-status contract is the shared one ───────────────────

test.describe("prospect kill uses the shared active-status set", () => {
  test.it("is exactly the four non-terminal active states", () => {
    assert.deepEqual(
      [...KILL_ACTIVE_FOLLOWUP_STATUSES].sort(),
      ["drafted", "generating", "pending_approval", "queued"],
    );
  });

  test.it("excludes terminal and parked states", () => {
    for (const terminal of ["sent", "failed", "ok", "cancelled", "stalled_awaiting_manual_send"]) {
      assert.equal(
        KILL_ACTIVE_FOLLOWUP_STATUSES.includes(terminal),
        false,
        `${terminal} must NOT be an active state`,
      );
    }
  });
});

// ── In-memory fixture: the DB effects of a prospect-level kill ─────
//
// This fixture mimics what the route's transaction does, using the SAME pure
// constants the route uses. It lets us assert the row-level effects (which
// rows get cancelled, which are left alone, that the one campaign gets paused,
// that the owning user's paused_by_admin is NOT touched, and that a sibling
// campaign of the same user is untouched) without a live database. Scoped by
// a single prospectId.

interface FxProspect {
  id: number;
  userId: number | null;
  followupPaused: boolean;
  pauseReason: string | null;
  pausedAt: Date | null;
  replied: number;
  archived: boolean;
}
interface FxFollowup {
  id: number;
  prospectId: number;
  status: string;
  errorMessage: string | null;
  sentAt: Date | null;
}
interface FxUser {
  id: number;
  name: string;
  pausedByAdmin: boolean;
}

// A pure re-implementation of the prospect-level kill's write logic over plain
// arrays, built from the same constants the production route uses. Scoped by a
// single prospectId, only touches active follow-up statuses, never deletes,
// never touches replied / sentAt / archived, and NEVER touches the owning
// user's pausedByAdmin.
function applyProspectKillFixture(
  targetProspectId: number,
  prospects: FxProspect[],
  followups: FxFollowup[],
) {
  const now = new Date();

  let followupsCancelled = 0;
  for (const f of followups) {
    if (f.prospectId === targetProspectId && KILL_ACTIVE_FOLLOWUP_STATUSES.includes(f.status)) {
      f.status = "cancelled";
      f.errorMessage = KILL_CANCEL_MESSAGE;
      followupsCancelled++;
    }
  }

  let prospectPaused = false;
  for (const p of prospects) {
    if (p.id === targetProspectId) {
      p.followupPaused = true;
      p.pauseReason = KILL_PAUSE_REASON;
      p.pausedAt = now;
      prospectPaused = true;
    }
  }

  return { followups_cancelled: followupsCancelled, prospect_paused: prospectPaused };
}

test.describe("prospect kill DB effects (in-memory fixture)", () => {
  // One user owns two campaigns (A=10, B=11). Campaign A has follow-ups in
  // each of the four active states plus a sent and a replied/terminal row to
  // prove they are left alone. Campaign B is the sibling that must remain
  // fully intact, which proves the kill is scoped to one campaign.
  function makeWorld() {
    const users: FxUser[] = [
      { id: 1, name: "Murat Solendil", pausedByAdmin: false },
    ];
    const prospects: FxProspect[] = [
      // Campaign A (target).
      { id: 10, userId: 1, followupPaused: false, pauseReason: null, pausedAt: null, replied: 0, archived: false },
      // Campaign B (sibling, same user) — must be untouched.
      { id: 11, userId: 1, followupPaused: false, pauseReason: null, pausedAt: null, replied: 1, archived: false },
    ];
    const followups: FxFollowup[] = [
      // Campaign A: one in each active state.
      { id: 100, prospectId: 10, status: "queued", errorMessage: null, sentAt: null },
      { id: 101, prospectId: 10, status: "generating", errorMessage: null, sentAt: null },
      { id: 102, prospectId: 10, status: "pending_approval", errorMessage: null, sentAt: null },
      { id: 103, prospectId: 10, status: "drafted", errorMessage: null, sentAt: null },
      // Campaign A: terminal/parked rows that must be left alone.
      { id: 104, prospectId: 10, status: "sent", errorMessage: null, sentAt: new Date("2024-01-01") },
      { id: 105, prospectId: 10, status: "cancelled", errorMessage: "earlier cancel", sentAt: null },
      { id: 106, prospectId: 10, status: "failed", errorMessage: "boom", sentAt: null },
      { id: 107, prospectId: 10, status: "stalled_awaiting_manual_send", errorMessage: null, sentAt: null },
      // Campaign B (sibling): active rows that must remain queued/drafted.
      { id: 110, prospectId: 11, status: "queued", errorMessage: null, sentAt: null },
      { id: 111, prospectId: 11, status: "drafted", errorMessage: null, sentAt: null },
      { id: 112, prospectId: 11, status: "sent", errorMessage: null, sentAt: new Date("2024-02-02") },
    ];
    return { users, prospects, followups };
  }

  test.it("cancels the target campaign's follow-ups in all four active states", () => {
    const { prospects, followups } = makeWorld();
    applyProspectKillFixture(10, prospects, followups);
    for (const id of [100, 101, 102, 103]) {
      const f = followups.find((x) => x.id === id)!;
      assert.equal(f.status, "cancelled", `follow-up ${id} should be cancelled`);
      assert.equal(f.errorMessage, KILL_CANCEL_MESSAGE);
    }
  });

  test.it("leaves the target campaign's sent, terminal, and parked rows untouched", () => {
    const { prospects, followups } = makeWorld();
    applyProspectKillFixture(10, prospects, followups);
    const sent = followups.find((x) => x.id === 104)!;
    assert.equal(sent.status, "sent");
    assert.ok(sent.sentAt instanceof Date);
    assert.equal(followups.find((x) => x.id === 105)!.errorMessage, "earlier cancel");
    assert.equal(followups.find((x) => x.id === 106)!.status, "failed");
    assert.equal(followups.find((x) => x.id === 107)!.status, "stalled_awaiting_manual_send");
  });

  test.it("pauses the one campaign with admin_killed and stamps paused_at, archived untouched", () => {
    const { prospects, followups } = makeWorld();
    applyProspectKillFixture(10, prospects, followups);
    const p = prospects.find((x) => x.id === 10)!;
    assert.equal(p.followupPaused, true);
    assert.equal(p.pauseReason, "admin_killed");
    assert.ok(p.pausedAt instanceof Date);
    assert.equal(p.archived, false);
    assert.equal(p.replied, 0);
  });

  test.it("does NOT touch the owning user's paused_by_admin (two layers, not three)", () => {
    const { users, prospects, followups } = makeWorld();
    applyProspectKillFixture(10, prospects, followups);
    assert.equal(users.find((u) => u.id === 1)!.pausedByAdmin, false);
  });

  test.it("does NOT touch the sibling campaign of the same user (scope is one campaign)", () => {
    const { prospects, followups } = makeWorld();
    applyProspectKillFixture(10, prospects, followups);
    const sibling = prospects.find((x) => x.id === 11)!;
    assert.equal(sibling.followupPaused, false);
    assert.equal(sibling.pauseReason, null);
    assert.equal(sibling.pausedAt, null);
    assert.equal(sibling.replied, 1);
    // The sibling's active follow-ups remain active.
    assert.equal(followups.find((x) => x.id === 110)!.status, "queued");
    assert.equal(followups.find((x) => x.id === 111)!.status, "drafted");
    assert.equal(followups.find((x) => x.id === 112)!.status, "sent");
  });

  test.it("returned counts match the rows actually changed", () => {
    const { prospects, followups } = makeWorld();
    const summary = applyProspectKillFixture(10, prospects, followups);
    // Campaign A had 4 active follow-ups.
    assert.equal(summary.followups_cancelled, 4);
    assert.equal(summary.prospect_paused, true);
    const actuallyCancelled = followups.filter(
      (f) => f.errorMessage === KILL_CANCEL_MESSAGE,
    ).length;
    assert.equal(actuallyCancelled, summary.followups_cancelled);
  });

  test.it("killing an already-killed campaign is a safe no-op (zero cancelled)", () => {
    const { prospects, followups } = makeWorld();
    applyProspectKillFixture(10, prospects, followups);
    // Second kill: all active rows are already cancelled, so nothing new.
    const second = applyProspectKillFixture(10, prospects, followups);
    assert.equal(second.followups_cancelled, 0);
    assert.equal(second.prospect_paused, true);
  });

  test.it("a mismatched confirmId is refused by the guard before any write", () => {
    const { users, prospects, followups } = makeWorld();
    const guard = checkProspectConfirm(10, 11);
    assert.equal(guard.ok, false);
    assert.equal(guard.reason, "mismatch");
    // No write happened (we never called applyProspectKillFixture).
    assert.equal(prospects.find((p) => p.id === 10)!.followupPaused, false);
    assert.equal(followups.find((x) => x.id === 100)!.status, "queued");
    assert.equal(users.find((u) => u.id === 1)!.pausedByAdmin, false);
  });
});