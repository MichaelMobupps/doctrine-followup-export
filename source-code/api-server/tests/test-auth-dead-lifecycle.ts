/**
 * test-auth-dead-lifecycle.ts — F-3.6a.
 *
 * Hermetic tests for the connection-health state machine and the auth probe.
 * No DB, no network, no Gmail — the probe's client is a hand-rolled fake.
 *
 * What these lock:
 *   - auth_dead is a THIRD state, and it does not read as connected. That
 *     confusion is the whole bug: on 2026-08-09 six of twelve accounts
 *     reported CONNECTED while Google refused every one of their grants.
 *   - only a genuine grant rejection marks an account dead — never a 5xx,
 *     never a quota error, never a database error.
 *   - only POSITIVE proof of health clears it. "The pass did not hit an auth
 *     error" is not proof; a pass that failed on the database never asked
 *     Google anything.
 *   - the first dead-date is preserved across repeated failures.
 *   - a reconnect clears the state.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-auth-dead-lifecycle.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  connectionState,
  isHeldByAuth,
  nextAuthState,
  signalFromSyncOutcome,
  classifyAuthReason,
  authDeadMessage,
  isAuthError,
} from "../lib/connectionHealth";
import { probeGmailGrant, signalFromProbe } from "../lib/authProbe";

const NOW = new Date("2026-08-09T14:00:00.000Z");
const DEAD_SINCE = new Date("2026-07-31T09:15:00.000Z");

test.describe("connectionState — three states, not two", () => {
  test.it("connected when the grant exists and is not dead", () => {
    assert.equal(connectionState({ isConnected: true, authDeadAt: null }), "connected");
  });

  test.it("auth_dead when a grant exists but Google refuses it", () => {
    assert.equal(connectionState({ isConnected: true, authDeadAt: DEAD_SINCE }), "auth_dead");
  });

  test.it("THE BUG: an auth-dead account must never read as connected", () => {
    // This is the assertion that would have caught the 2026-08-09 state.
    assert.notEqual(connectionState({ isConnected: true, authDeadAt: DEAD_SINCE }), "connected");
  });

  test.it("disconnected when there is no grant at all", () => {
    assert.equal(connectionState({ isConnected: false, authDeadAt: null }), "disconnected");
  });

  test.it("an explicit disconnect WINS over a stale auth-dead mark", () => {
    assert.equal(connectionState({ isConnected: false, authDeadAt: DEAD_SINCE }), "disconnected");
  });

  test.it("accepts an ISO string as well as a Date (jsonb/driver round-trips)", () => {
    assert.equal(connectionState({ isConnected: true, authDeadAt: DEAD_SINCE.toISOString() }), "auth_dead");
  });

  test.it("isHeldByAuth is true only in the auth_dead state", () => {
    assert.equal(isHeldByAuth({ isConnected: true, authDeadAt: DEAD_SINCE }), true);
    assert.equal(isHeldByAuth({ isConnected: true, authDeadAt: null }), false);
    assert.equal(isHeldByAuth({ isConnected: false, authDeadAt: DEAD_SINCE }), false);
  });
});

test.describe("isAuthError — narrow on purpose", () => {
  test.it("matches the three grant-rejection tokens Google uses", () => {
    assert.equal(isAuthError(new Error("invalid_grant: Token has been expired or revoked")), true);
    assert.equal(isAuthError(new Error("unauthorized_client")), true);
    assert.equal(isAuthError(new Error("invalid_client: no registered origin")), true);
  });

  test.it("reads the nested response.data googleapis attaches", () => {
    const err = Object.assign(new Error("Request failed"), {
      response: { data: { error: "unauthorized_client" } },
    });
    assert.equal(isAuthError(err), true);
  });

  test.it("does NOT match a transient outage — marking those dead stops a healthy sender", () => {
    assert.equal(isAuthError(new Error("Internal error encountered (500)")), false);
    assert.equal(isAuthError(new Error("The service is currently unavailable (503)")), false);
    assert.equal(isAuthError(new Error("socket hang up")), false);
    assert.equal(isAuthError(new Error("ETIMEDOUT")), false);
  });

  test.it("does NOT match a quota error", () => {
    assert.equal(isAuthError(new Error("Quota exceeded for quota metric 'Queries'")), false);
    assert.equal(isAuthError(new Error("User-rate limit exceeded (429)")), false);
  });

  test.it("does NOT match a database error", () => {
    assert.equal(isAuthError(new Error('Failed query: select "id" from "users" where id = $1')), false);
  });

  test.it("survives a circular response payload without throwing", () => {
    const circular: Record<string, unknown> = { error: "unauthorized_client" };
    circular.self = circular;
    const err = Object.assign(new Error("boom"), { response: { data: circular } });
    assert.equal(isAuthError(err), true);
  });

  test.it("handles non-Error throws", () => {
    assert.equal(isAuthError("invalid_grant"), true);
    assert.equal(isAuthError(null), false);
    assert.equal(isAuthError(undefined), false);
  });
});

test.describe("signalFromSyncOutcome — 'not an auth error' is not health", () => {
  test.it("an auth failure is an auth failure", () => {
    assert.equal(signalFromSyncOutcome({ authFailure: true }), "auth_failure");
  });

  test.it("a completed ingest is positive proof the grant works", () => {
    assert.equal(signalFromSyncOutcome({}), "healthy");
  });

  test.it("a reply-scan error alone is still health — Gmail already answered in ingest", () => {
    assert.equal(signalFromSyncOutcome({ replyError: "summarizer timeout" }), "healthy");
  });

  test.it("CRITICAL: an ingest error that is NOT an auth error is inconclusive, never health", () => {
    // If this returned "healthy" it would clear a genuinely dead grant on the
    // first database hiccup and put the account straight back into the burn
    // loop this order exists to stop.
    assert.equal(
      signalFromSyncOutcome({ ingestError: "Failed query: insert into prospects" }),
      "inconclusive",
    );
  });

  test.it("an auth failure wins over everything else in the outcome", () => {
    assert.equal(
      signalFromSyncOutcome({ authFailure: true, ingestError: "unauthorized_client", replyError: "x" }),
      "auth_failure",
    );
  });
});

test.describe("nextAuthState — six cases, two writes", () => {
  test.it("healthy + auth_failure → marks dead now, with the classified reason", () => {
    const t = nextAuthState({
      currentAuthDeadAt: null,
      signal: "auth_failure",
      reason: "unauthorized_client",
      now: NOW,
    });
    assert.equal(t.changed, true);
    assert.deepEqual(t.authDeadAt, NOW);
    assert.equal(t.authDeadReason, "unauthorized_client");
  });

  test.it("dead + auth_failure → NO WRITE, first date preserved", () => {
    const t = nextAuthState({
      currentAuthDeadAt: DEAD_SINCE,
      signal: "auth_failure",
      reason: "unauthorized_client",
      now: NOW,
    });
    assert.equal(t.changed, false, "must not rewrite an existing dead date every 15 minutes");
    assert.equal(t.authDeadAt?.toISOString(), DEAD_SINCE.toISOString());
  });

  test.it("dead + healthy → clears (a false positive self-heals on the next tick)", () => {
    const t = nextAuthState({ currentAuthDeadAt: DEAD_SINCE, signal: "healthy", now: NOW });
    assert.equal(t.changed, true);
    assert.equal(t.authDeadAt, null);
    assert.equal(t.authDeadReason, null);
  });

  test.it("dead + inconclusive → NO WRITE, stays dead", () => {
    const t = nextAuthState({ currentAuthDeadAt: DEAD_SINCE, signal: "inconclusive", now: NOW });
    assert.equal(t.changed, false);
    assert.equal(t.authDeadAt?.toISOString(), DEAD_SINCE.toISOString());
  });

  test.it("healthy + healthy → NO WRITE (no row churn on a normal tick)", () => {
    const t = nextAuthState({ currentAuthDeadAt: null, signal: "healthy", now: NOW });
    assert.equal(t.changed, false);
  });

  test.it("healthy + inconclusive → NO WRITE", () => {
    const t = nextAuthState({ currentAuthDeadAt: null, signal: "inconclusive", now: NOW });
    assert.equal(t.changed, false);
  });

  test.it("a garbage stored date is treated as not-dead rather than throwing", () => {
    const t = nextAuthState({ currentAuthDeadAt: "not-a-date", signal: "auth_failure", now: NOW });
    assert.equal(t.changed, true);
    assert.deepEqual(t.authDeadAt, NOW);
  });

  test.it("full lifecycle: healthy → dead → still dead → reconnect-equivalent heal", () => {
    let dead: Date | null = null;

    let t = nextAuthState({ currentAuthDeadAt: dead, signal: "auth_failure", reason: "invalid_grant", now: DEAD_SINCE });
    assert.equal(t.changed, true);
    dead = t.authDeadAt;
    assert.equal(connectionState({ isConnected: true, authDeadAt: dead }), "auth_dead");

    t = nextAuthState({ currentAuthDeadAt: dead, signal: "auth_failure", now: NOW });
    assert.equal(t.changed, false);
    assert.equal(dead?.toISOString(), DEAD_SINCE.toISOString());

    t = nextAuthState({ currentAuthDeadAt: dead, signal: "healthy", now: NOW });
    assert.equal(t.changed, true);
    dead = t.authDeadAt;
    assert.equal(connectionState({ isConnected: true, authDeadAt: dead }), "connected");
  });
});

test.describe("classifyAuthReason — closed vocabulary, never raw provider text", () => {
  test.it("names each known class", () => {
    assert.equal(classifyAuthReason("Error: unauthorized_client blah"), "unauthorized_client");
    assert.equal(classifyAuthReason("invalid_grant: expired"), "invalid_grant");
    assert.equal(classifyAuthReason("invalid_client"), "invalid_client");
    assert.equal(classifyAuthReason("deleted_client: The OAuth client was deleted."), "deleted_client");
  });

  test.it("falls back to a bounded marker for anything else", () => {
    assert.equal(classifyAuthReason("something entirely new"), "auth_rejected");
    assert.equal(classifyAuthReason(null), "auth_rejected");
    assert.equal(classifyAuthReason(undefined), "auth_rejected");
  });

  test.it("never returns attacker-controlled text — output is always from the closed set", () => {
    const hostile = '<img src=x onerror=alert(1)> unauthorized_client';
    const out = classifyAuthReason(hostile);
    assert.equal(out, "unauthorized_client");
    assert.ok(!out.includes("<"), "no markup can reach the stored reason");
  });
});

test.describe("authDeadMessage — the sentence the operator reads", () => {
  test.it("is plain words with the date", () => {
    assert.equal(authDeadMessage(DEAD_SINCE), "Gmail connection dead since 2026-07-31 — reconnect");
  });

  test.it("is null when the account is not dead", () => {
    assert.equal(authDeadMessage(null), null);
    assert.equal(authDeadMessage(undefined), null);
  });

  test.it("is null rather than 'Invalid Date' for garbage", () => {
    assert.equal(authDeadMessage("nonsense"), null);
  });
});

// ── The probe, against a fake Gmail ──────────────────────────────────────

function fakeGmail(behaviour: "ok" | Error) {
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      users: {
        async getProfile(params: { userId: string }) {
          calls++;
          assert.equal(params.userId, "me");
          if (behaviour instanceof Error) throw behaviour;
          return { data: { emailAddress: "someone@example.com" } };
        },
      },
    },
  };
}

test.describe("probeGmailGrant", () => {
  test.it("reports ok when Gmail answers, using exactly one read call", async () => {
    const g = fakeGmail("ok");
    const r = await probeGmailGrant(g.client);
    assert.deepEqual(r, { ok: true });
    assert.equal(g.calls(), 1, "the probe must be one cheap call, not a list or a fetch");
  });

  test.it("reports an auth failure for a refused grant", async () => {
    const g = fakeGmail(new Error("unauthorized_client"));
    const r = await probeGmailGrant(g.client);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.authFailure, true);
  });

  test.it("reports a NON-auth failure for an outage — this must not mark anyone dead", async () => {
    const g = fakeGmail(new Error("503 Service Unavailable"));
    const r = await probeGmailGrant(g.client);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.authFailure, false);
  });

  test.it("never throws, whatever the client does", async () => {
    const weird = { users: { getProfile: async () => { throw "a bare string"; } } };
    const r = await probeGmailGrant(weird);
    assert.equal(r.ok, false);
  });

  test.it("maps onto the state-machine vocabulary", async () => {
    assert.equal(signalFromProbe(await probeGmailGrant(fakeGmail("ok").client)), "healthy");
    assert.equal(
      signalFromProbe(await probeGmailGrant(fakeGmail(new Error("invalid_grant")).client)),
      "auth_failure",
    );
    assert.equal(
      signalFromProbe(await probeGmailGrant(fakeGmail(new Error("500")).client)),
      "inconclusive",
    );
  });

  test.it("an outage during the deploy-time backfill leaves a healthy account healthy", async () => {
    const probe = await probeGmailGrant(fakeGmail(new Error("ETIMEDOUT")).client);
    const t = nextAuthState({
      currentAuthDeadAt: null,
      signal: signalFromProbe(probe),
      now: NOW,
    });
    assert.equal(t.changed, false, "a boot-time outage must never mark the whole fleet dead");
  });
});
