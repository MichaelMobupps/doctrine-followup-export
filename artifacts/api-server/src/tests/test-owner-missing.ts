/**
 * test-owner-missing.ts — F-3.6b.
 *
 * The ownerless-prospect refusal. Hermetic; no DB, no network, no env.
 *
 * THE PRODUCTION STATE THIS COVERS
 *
 * `prospects.user_id` is nullable. Until F-3.6b the send path opened with
 *
 *     let senderEmail = process.env.SENDER_EMAIL || "";
 *     let senderName  = process.env.SENDER_NAME  || "Team";
 *
 * and `sendFollowupReply` fell back to a Gmail client authorised with
 * `process.env.GOOGLE_REFRESH_TOKEN`. A row with no owner never entered the
 * owner branch, so it kept all three and was DELIVERED — from the shared
 * fallback mailbox, under an identity unrelated to the campaign that owns it.
 * All three variables are set in this deployment.
 *
 * F-3.6a's smoke found it by accident: a fixture row seeded with a null user,
 * expected to be skipped, reached Google and came back "Invalid thread_id
 * value". Nothing was delivered only because the thread id was fake.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-owner-missing.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  resolveSendIdentity,
  OWNER_MISSING_MESSAGE,
  type SendIdentityOwner,
} from "../lib/ownerIdentity";
import { decideFailedRowAction, MAX_AUTO_RETRIES } from "../lib/retryPolicy";
import { FAILURE_REASONS } from "@workspace/db";

const HEALTHY: SendIdentityOwner = {
  email: "owner@example.com",
  name: "Owner Name",
  googleRefreshToken: "refresh-token",
  isConnected: true,
};

// ---------------------------------------------------------------------------
// A. the refusal itself
// ---------------------------------------------------------------------------
test.describe("resolveSendIdentity — no owner, no identity", () => {
  test.it("a null user_id refuses with owner_missing", () => {
    const r = resolveSendIdentity({ userId: null, owner: null });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "owner_missing");
  });

  test.it("an undefined user_id refuses with owner_missing", () => {
    const r = resolveSendIdentity({ userId: undefined, owner: undefined });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "owner_missing");
  });

  test.it(
    "THE FIX: a null user_id refuses even when a fallback owner is offered alongside it",
    () => {
      // The shape of the deleted bug: an identity was available, it just was
      // not this prospect's. No amount of available credentials makes an
      // ownerless row sendable.
      const r = resolveSendIdentity({ userId: null, owner: HEALTHY });
      assert.equal(r.ok, false);
      assert.equal(r.ok === false && r.reason, "owner_missing");
    },
  );

  test.it("owner_missing and credentials_unavailable are DIFFERENT refusals", () => {
    const ownerless = resolveSendIdentity({ userId: null, owner: null });
    const disconnected = resolveSendIdentity({
      userId: 7,
      owner: { ...HEALTHY, isConnected: false },
    });
    assert.equal(ownerless.ok === false && ownerless.reason, "owner_missing");
    assert.equal(disconnected.ok === false && disconnected.reason, "credentials_unavailable");
    // Conflating them is how the defect hid: one is a waiting state a
    // reconnect fixes, the other is a data defect waiting fixes nothing.
    assert.notEqual(
      ownerless.ok === false && ownerless.reason,
      disconnected.ok === false && disconnected.reason,
    );
  });
});

// ---------------------------------------------------------------------------
// B. an owner that cannot send is not the same as no owner
// ---------------------------------------------------------------------------
test.describe("resolveSendIdentity — owner present", () => {
  test.it("a missing user row refuses credentials_unavailable, not owner_missing", () => {
    // A stale foreign key: the id is there, the account is gone.
    const r = resolveSendIdentity({ userId: 42, owner: null });
    assert.equal(r.ok === false && r.reason, "credentials_unavailable");
  });

  test.it("no refresh token refuses", () => {
    const r = resolveSendIdentity({ userId: 7, owner: { ...HEALTHY, googleRefreshToken: null } });
    assert.equal(r.ok === false && r.reason, "credentials_unavailable");
  });

  test.it("an empty-string refresh token refuses", () => {
    const r = resolveSendIdentity({ userId: 7, owner: { ...HEALTHY, googleRefreshToken: "" } });
    assert.equal(r.ok === false && r.reason, "credentials_unavailable");
  });

  test.it("a disconnected account refuses", () => {
    const r = resolveSendIdentity({ userId: 7, owner: { ...HEALTHY, isConnected: false } });
    assert.equal(r.ok === false && r.reason, "credentials_unavailable");
  });
});

// ---------------------------------------------------------------------------
// C. the healthy path is byte-for-byte what the scheduler used to build
// ---------------------------------------------------------------------------
test.describe("resolveSendIdentity — the identity it builds", () => {
  test.it("uses the owner's address and name", () => {
    const r = resolveSendIdentity({ userId: 7, owner: HEALTHY });
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.senderEmail, "owner@example.com");
    assert.equal(r.ok === true && r.senderName, "Owner Name");
    assert.equal(r.ok === true && r.refreshToken, "refresh-token");
  });

  test.it("falls back to the local part when the account has no name", () => {
    const r = resolveSendIdentity({ userId: 7, owner: { ...HEALTHY, name: null } });
    assert.equal(r.ok === true && r.senderName, "owner");
  });

  test.it("an empty name is treated as absent", () => {
    const r = resolveSendIdentity({ userId: 7, owner: { ...HEALTHY, name: "" } });
    assert.equal(r.ok === true && r.senderName, "owner");
  });

  test.it("never returns an identity that did not come from the owner row", () => {
    // Structural: whatever the environment holds, the resolver has no way to
    // reach it — there is no process.env in ownerIdentity.ts at all.
    const before = process.env.SENDER_EMAIL;
    process.env.SENDER_EMAIL = "fallback@example.com";
    try {
      const r = resolveSendIdentity({ userId: null, owner: null });
      assert.equal(r.ok, false);
      const healthy = resolveSendIdentity({ userId: 7, owner: HEALTHY });
      assert.equal(healthy.ok === true && healthy.senderEmail, "owner@example.com");
    } finally {
      if (before === undefined) delete process.env.SENDER_EMAIL;
      else process.env.SENDER_EMAIL = before;
    }
  });
});

// ---------------------------------------------------------------------------
// D. the operator sentence written onto the row
// ---------------------------------------------------------------------------
test.describe("the recorded failure", () => {
  test.it("owner_missing is a declared failure reason", () => {
    assert.ok((FAILURE_REASONS as readonly string[]).includes("owner_missing"));
  });

  test.it("the message says what is wrong and what fixes it", () => {
    assert.match(OWNER_MISSING_MESSAGE, /no user_id/i);
    assert.match(OWNER_MISSING_MESSAGE, /REFUSED/);
    assert.match(OWNER_MISSING_MESSAGE, /Assign the prospect to an account/i);
  });

  test.it("the message records what the row would have done before F-3.6b", () => {
    // A failure whose text does not explain itself gets re-queued by a human
    // who assumes it was transient.
    assert.match(OWNER_MISSING_MESSAGE, /fallback mailbox/i);
  });
});

// ---------------------------------------------------------------------------
// E. the retry policy for an ownerless row
// ---------------------------------------------------------------------------
test.describe("retry policy — owner_missing", () => {
  test.it("an ownerless row is HELD, not retried", () => {
    const d = decideFailedRowAction({
      retryCount: 0,
      failureReason: "owner_missing",
      ownerAuthDead: false,
      ownerMissing: true,
    });
    assert.equal(d.action, "hold");
    assert.equal(d.action === "hold" && d.reason, "owner_missing");
  });

  test.it("it is held even at retryCount 0 — no strike is ever spent on it", () => {
    for (let n = 0; n <= MAX_AUTO_RETRIES + 1; n++) {
      const d = decideFailedRowAction({
        retryCount: n,
        failureReason: "owner_missing",
        ownerAuthDead: false,
        ownerMissing: true,
      });
      assert.equal(d.action, "hold", `retryCount ${n}`);
      assert.equal(d.action === "hold" && d.reason, "owner_missing", `retryCount ${n}`);
    }
  });

  test.it("THE HEAL: once an owner is assigned the row retries, no strike spent", () => {
    // The stale reason string still says owner_missing. The decision reads the
    // CURRENT state of the world instead, exactly as it does for auth_dead.
    const d = decideFailedRowAction({
      retryCount: 1,
      failureReason: "owner_missing",
      ownerAuthDead: false,
      ownerMissing: false,
    });
    assert.equal(d.action, "retry");
    assert.equal(d.action === "retry" && d.nextRetryCount, 1);
  });

  test.it("a healed ownerless row at the retry cap still retries", () => {
    // It never earned those strikes for this cause; charging them would make
    // an assigned owner silently drop the follow-ups it just inherited.
    const d = decideFailedRowAction({
      retryCount: MAX_AUTO_RETRIES,
      failureReason: "owner_missing",
      ownerAuthDead: false,
      ownerMissing: false,
    });
    assert.equal(d.action, "retry");
  });

  test.it("stranded still outranks owner_missing — a delivered email is never re-sent", () => {
    const d = decideFailedRowAction({
      retryCount: 0,
      failureReason: "stranded",
      ownerAuthDead: false,
      ownerMissing: true,
    });
    assert.equal(d.action === "hold" && d.reason, "stranded_needs_human");
  });

  test.it("owner_missing outranks auth_dead when both are true", () => {
    // Not arbitrary: an ownerless prospect has no account whose grant could be
    // healed, so reporting auth_dead would point the operator at a reconnect
    // button that cannot help.
    const d = decideFailedRowAction({
      retryCount: 0,
      failureReason: "send_error",
      ownerAuthDead: true,
      ownerMissing: true,
    });
    assert.equal(d.action === "hold" && d.reason, "owner_missing");
  });

  test.it("omitting ownerMissing leaves every pre-F-3.6b decision unchanged", () => {
    assert.deepEqual(
      decideFailedRowAction({ retryCount: 0, failureReason: "send_error", ownerAuthDead: false }),
      { action: "retry", nextRetryCount: 1 },
    );
    assert.deepEqual(
      decideFailedRowAction({ retryCount: MAX_AUTO_RETRIES, failureReason: "send_error", ownerAuthDead: false }),
      { action: "hold", reason: "retries_exhausted" },
    );
    assert.deepEqual(
      decideFailedRowAction({ retryCount: 0, failureReason: "auth_dead", ownerAuthDead: true }),
      { action: "hold", reason: "auth_dead" },
    );
    assert.deepEqual(
      decideFailedRowAction({ retryCount: 1, failureReason: "auth_dead", ownerAuthDead: false }),
      { action: "retry", nextRetryCount: 1 },
    );
    assert.deepEqual(
      decideFailedRowAction({ retryCount: 0, failureReason: "stranded", ownerAuthDead: false }),
      { action: "hold", reason: "stranded_needs_human" },
    );
  });
});
