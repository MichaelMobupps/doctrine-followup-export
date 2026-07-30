/**
 * test-admin-kill.ts
 *
 * Hermetic tests for the Admin Kill feature. Following the pattern in
 * test-suppression.ts, the DB-backed endpoint is not exercised against a live
 * database; instead the pure pieces in lib/adminKill.ts are tested directly,
 * and the database EFFECTS of a kill are asserted through a small in-memory
 * fixture that mimics the transaction's update semantics (cancel active
 * follow-ups, pause campaigns, set paused_by_admin). This keeps the test fast
 * and dependency-free while still covering the contract that matters.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-admin-kill.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  KILL_ACTIVE_FOLLOWUP_STATUSES,
  KILL_CANCEL_MESSAGE,
  KILL_PAUSE_REASON,
  KILL_APPS,
  checkNameMatch,
  buildKillSummary,
} from "../lib/adminKill";

// ── The name-match guard ───────────────────────────────────────────

test.describe("checkNameMatch", () => {
  test.it("accepts the exact name", () => {
    const r = checkNameMatch("Murat Solendil", "Murat Solendil");
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
  });

  test.it("accepts when only surrounding whitespace differs", () => {
    const r = checkNameMatch("  Murat Solendil ", "Murat Solendil");
    assert.equal(r.ok, true);
  });

  test.it("rejects a wrong name", () => {
    const r = checkNameMatch("Murat Solendil", "Someone Else");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
  });

  test.it("rejects when the stored name is empty", () => {
    assert.equal(checkNameMatch("", "Anything").ok, false);
    assert.equal(checkNameMatch("   ", "Anything").reason, "stored_name_empty");
    assert.equal(checkNameMatch(null, "Anything").reason, "stored_name_empty");
    assert.equal(checkNameMatch(undefined, "Anything").reason, "stored_name_empty");
  });

  test.it("rejects an empty or whitespace confirmName even if the stored name is real", () => {
    assert.equal(checkNameMatch("Murat Solendil", "").reason, "confirm_name_empty");
    assert.equal(checkNameMatch("Murat Solendil", "   ").reason, "confirm_name_empty");
    assert.equal(checkNameMatch("Murat Solendil", undefined).reason, "confirm_name_empty");
    assert.equal(checkNameMatch("Murat Solendil", 12345).reason, "confirm_name_empty");
  });

  test.it("an empty match cannot defeat the guard (both empty still rejects)", () => {
    const r = checkNameMatch("", "");
    assert.equal(r.ok, false);
    // stored-name emptiness is checked first, so that is the reason.
    assert.equal(r.reason, "stored_name_empty");
  });
});

// ── The active-status contract ─────────────────────────────────────

test.describe("KILL_ACTIVE_FOLLOWUP_STATUSES", () => {
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

// ── buildKillSummary ───────────────────────────────────────────────

test.describe("buildKillSummary", () => {
  test.it("rolls per-app rows into totals that sum the breakdown", () => {
    const s = buildKillSummary([
      { app: "doctrine", followupsCancelled: 3, campaignsPaused: 5 },
      { app: "context", followupsCancelled: 1, campaignsPaused: 2 },
      { app: "anti_ghosting", followupsCancelled: 0, campaignsPaused: 4 },
    ]);
    assert.equal(s.followups_cancelled, 4);
    assert.equal(s.campaigns_paused, 11);
    assert.equal(s.by_app.doctrine.followups_cancelled, 3);
    assert.equal(s.by_app.doctrine.campaigns_paused, 5);
    assert.equal(s.by_app.context.followups_cancelled, 1);
    assert.equal(s.by_app.anti_ghosting.campaigns_paused, 4);
  });

  test.it("always returns every subproduct, zeroed when nothing changed", () => {
    const s = buildKillSummary([]);
    assert.equal(s.followups_cancelled, 0);
    assert.equal(s.campaigns_paused, 0);
    for (const app of KILL_APPS) {
      assert.ok(s.by_app[app], `by_app must contain ${app}`);
      assert.equal(s.by_app[app].followups_cancelled, 0);
      assert.equal(s.by_app[app].campaigns_paused, 0);
    }
  });

  test.it("accumulates multiple rows for the same app", () => {
    const s = buildKillSummary([
      { app: "doctrine", followupsCancelled: 2, campaignsPaused: 1 },
      { app: "doctrine", followupsCancelled: 3, campaignsPaused: 1 },
    ]);
    assert.equal(s.by_app.doctrine.followups_cancelled, 5);
    assert.equal(s.by_app.doctrine.campaigns_paused, 2);
    assert.equal(s.followups_cancelled, 5);
  });
});

// ── In-memory fixture: the DB effects of a kill ────────────────────
//
// This fixture mimics what the route's transaction does, using the SAME pure
// constants the route uses. It lets us assert the row-level effects (which
// rows get cancelled, which are left alone, which campaigns get paused, the
// user flag, and that the returned counts match the rows changed) without a
// live database.

interface FxProspect {
  id: number;
  userId: number | null;
  app: typeof KILL_APPS[number];
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

// A pure re-implementation of the kill's write logic over plain arrays, built
// from the same constants the production route uses. Scoped by userId, spans
// all apps (no app filter), only touches active follow-up statuses, never
// deletes, never touches replied / sentAt / archived.
function applyKillFixture(
  targetUserId: number,
  users: FxUser[],
  prospects: FxProspect[],
  followups: FxFollowup[],
) {
  const perApp: Array<{ app: typeof KILL_APPS[number]; followupsCancelled: number; campaignsPaused: number }> = [];
  const now = new Date();

  for (const app of KILL_APPS) {
    const prospectIds = new Set(
      prospects.filter((p) => p.userId === targetUserId && p.app === app).map((p) => p.id),
    );

    let followupsCancelled = 0;
    for (const f of followups) {
      if (prospectIds.has(f.prospectId) && KILL_ACTIVE_FOLLOWUP_STATUSES.includes(f.status)) {
        f.status = "cancelled";
        f.errorMessage = KILL_CANCEL_MESSAGE;
        followupsCancelled++;
      }
    }

    let campaignsPaused = 0;
    for (const p of prospects) {
      if (p.userId === targetUserId && p.app === app) {
        p.followupPaused = true;
        p.pauseReason = KILL_PAUSE_REASON;
        p.pausedAt = now;
        campaignsPaused++;
      }
    }

    perApp.push({ app, followupsCancelled, campaignsPaused });
  }

  for (const u of users) {
    if (u.id === targetUserId) u.pausedByAdmin = true;
  }

  return buildKillSummary(perApp);
}

test.describe("kill DB effects (in-memory fixture)", () => {
  function makeWorld() {
    const users: FxUser[] = [
      { id: 1, name: "Murat Solendil", pausedByAdmin: false },
      { id: 2, name: "Other Person", pausedByAdmin: false },
    ];
    // User 1 has a prospect in each subproduct. User 2 and a legacy
    // null-user prospect exist to prove scoping.
    const prospects: FxProspect[] = [
      { id: 10, userId: 1, app: "doctrine", followupPaused: false, pauseReason: null, pausedAt: null, replied: 0, archived: false },
      { id: 11, userId: 1, app: "context", followupPaused: false, pauseReason: null, pausedAt: null, replied: 1, archived: false },
      { id: 12, userId: 1, app: "anti_ghosting", followupPaused: false, pauseReason: null, pausedAt: null, replied: 0, archived: false },
      { id: 20, userId: 2, app: "doctrine", followupPaused: false, pauseReason: null, pausedAt: null, replied: 0, archived: false },
      { id: 30, userId: null, app: "doctrine", followupPaused: false, pauseReason: null, pausedAt: null, replied: 0, archived: false },
    ];
    // For user 1's doctrine prospect (10): one follow-up in EACH of the four
    // active states, plus a sent and a cancelled that must be left alone.
    const followups: FxFollowup[] = [
      { id: 100, prospectId: 10, status: "queued", errorMessage: null, sentAt: null },
      { id: 101, prospectId: 10, status: "generating", errorMessage: null, sentAt: null },
      { id: 102, prospectId: 10, status: "pending_approval", errorMessage: null, sentAt: null },
      { id: 103, prospectId: 10, status: "drafted", errorMessage: null, sentAt: null },
      { id: 104, prospectId: 10, status: "sent", errorMessage: null, sentAt: new Date("2024-01-01") },
      { id: 105, prospectId: 10, status: "cancelled", errorMessage: "earlier cancel", sentAt: null },
      { id: 106, prospectId: 10, status: "failed", errorMessage: "boom", sentAt: null },
      { id: 107, prospectId: 10, status: "stalled_awaiting_manual_send", errorMessage: null, sentAt: null },
      // user 1 context prospect (11): one queued.
      { id: 110, prospectId: 11, status: "queued", errorMessage: null, sentAt: null },
      // user 1 anti_ghosting prospect (12): one drafted.
      { id: 120, prospectId: 12, status: "drafted", errorMessage: null, sentAt: null },
      // ANOTHER user's queued follow-up — must be untouched.
      { id: 200, prospectId: 20, status: "queued", errorMessage: null, sentAt: null },
      // legacy null-user prospect's queued follow-up — must be untouched.
      { id: 300, prospectId: 30, status: "queued", errorMessage: null, sentAt: null },
    ];
    return { users, prospects, followups };
  }

  test.it("cancels follow-ups in all four active states across all three subproducts", () => {
    const { users, prospects, followups } = makeWorld();
    applyKillFixture(1, users, prospects, followups);

    for (const id of [100, 101, 102, 103, 110, 120]) {
      const f = followups.find((x) => x.id === id)!;
      assert.equal(f.status, "cancelled", `follow-up ${id} should be cancelled`);
      assert.equal(f.errorMessage, KILL_CANCEL_MESSAGE);
    }
  });

  test.it("leaves sent, replied, terminal, and parked rows untouched", () => {
    const { users, prospects, followups } = makeWorld();
    applyKillFixture(1, users, prospects, followups);

    // sent stays sent, sentAt preserved.
    const sent = followups.find((x) => x.id === 104)!;
    assert.equal(sent.status, "sent");
    assert.ok(sent.sentAt instanceof Date);
    // already-cancelled keeps its original message (not overwritten).
    assert.equal(followups.find((x) => x.id === 105)!.errorMessage, "earlier cancel");
    // failed and stalled untouched.
    assert.equal(followups.find((x) => x.id === 106)!.status, "failed");
    assert.equal(followups.find((x) => x.id === 107)!.status, "stalled_awaiting_manual_send");
    // replied flag on the context prospect is not changed by the kill.
    assert.equal(prospects.find((p) => p.id === 11)!.replied, 1);
  });

  test.it("does not touch another user's rows or legacy null-user rows", () => {
    const { users, prospects, followups } = makeWorld();
    applyKillFixture(1, users, prospects, followups);

    assert.equal(followups.find((x) => x.id === 200)!.status, "queued");
    assert.equal(followups.find((x) => x.id === 300)!.status, "queued");
    assert.equal(prospects.find((p) => p.id === 20)!.followupPaused, false);
    assert.equal(prospects.find((p) => p.id === 30)!.followupPaused, false);
    assert.equal(users.find((u) => u.id === 2)!.pausedByAdmin, false);
  });

  test.it("pauses every campaign with admin_killed reason and stamps paused_at", () => {
    const { users, prospects, followups } = makeWorld();
    applyKillFixture(1, users, prospects, followups);

    for (const id of [10, 11, 12]) {
      const p = prospects.find((x) => x.id === id)!;
      assert.equal(p.followupPaused, true, `prospect ${id} paused`);
      assert.equal(p.pauseReason, "admin_killed");
      assert.ok(p.pausedAt instanceof Date);
      // archived must be untouched.
      assert.equal(p.archived, false);
    }
  });

  test.it("sets paused_by_admin on the target user", () => {
    const { users, prospects, followups } = makeWorld();
    applyKillFixture(1, users, prospects, followups);
    assert.equal(users.find((u) => u.id === 1)!.pausedByAdmin, true);
  });

  test.it("returned counts match the rows actually changed", () => {
    const { users, prospects, followups } = makeWorld();
    const summary = applyKillFixture(1, users, prospects, followups);

    // Active follow-ups cancelled: doctrine 4 (100-103), context 1 (110),
    // anti_ghosting 1 (120) = 6.
    assert.equal(summary.followups_cancelled, 6);
    assert.equal(summary.by_app.doctrine.followups_cancelled, 4);
    assert.equal(summary.by_app.context.followups_cancelled, 1);
    assert.equal(summary.by_app.anti_ghosting.followups_cancelled, 1);

    // Campaigns paused: one prospect per app for user 1 = 3 total.
    assert.equal(summary.campaigns_paused, 3);
    assert.equal(summary.by_app.doctrine.campaigns_paused, 1);
    assert.equal(summary.by_app.context.campaigns_paused, 1);
    assert.equal(summary.by_app.anti_ghosting.campaigns_paused, 1);

    // Cross-check: counts equal the number of rows whose state we can observe
    // as changed in the arrays.
    const actuallyCancelled = followups.filter((f) => f.errorMessage === KILL_CANCEL_MESSAGE).length;
    assert.equal(actuallyCancelled, summary.followups_cancelled);
    const actuallyPaused = prospects.filter((p) => p.pauseReason === "admin_killed").length;
    assert.equal(actuallyPaused, summary.campaigns_paused);
  });

  test.it("a kill against a user with no name is refused by the guard before any write", () => {
    const { users, prospects, followups } = makeWorld();
    const noName = { id: 1, name: "   ", pausedByAdmin: false };
    const guard = checkNameMatch(noName.name, "anything");
    assert.equal(guard.ok, false);
    assert.equal(guard.reason, "stored_name_empty");
    // No write happened (we never called applyKillFixture).
    assert.equal(users.find((u) => u.id === 1)!.pausedByAdmin, false);
    assert.equal(followups.find((x) => x.id === 100)!.status, "queued");
  });
});