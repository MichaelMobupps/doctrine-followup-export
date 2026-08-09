/**
 * test-heartbeat-endpoint.ts — F-3.6a.
 *
 * Hermetic tests for the cron-heartbeat read surface: the admin gate, the
 * query parsing, and — the part that matters — the redaction applied to every
 * `details` payload before it leaves the process. No DB, no network.
 *
 * WHY REDACTION IS TESTED THIS HARD
 *
 * `cron_heartbeats.details` is written by the cron wrappers and includes
 * `perUser[].ingestError` — raw error text from googleapis. A googleapis
 * failure can serialise its request config, and a request config carries
 * `Authorization: Bearer ya29.…`. Nothing in the WRITE path prevents that, so
 * the READ path must assume it happened. This endpoint is the first thing
 * that ever exposed that column outside the process.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-heartbeat-endpoint.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  parseHeartbeatQuery,
  redactHeartbeatDetails,
  redactString,
  REDACTED,
  DEFAULT_HEARTBEAT_LIMIT,
  MAX_HEARTBEAT_LIMIT,
} from "../lib/heartbeatView";
import { requireAdmin } from "../middlewares/requireAdmin";

// ── The gate ─────────────────────────────────────────────────────────────

function fakeRes() {
  const state: { code?: number; body?: unknown } = {};
  const res = {
    status(c: number) { state.code = c; return res; },
    json(b: unknown) { state.body = b; return res; },
  };
  return { res, state };
}

function runGate(headers: Record<string, unknown>, adminKey: string | undefined) {
  const prior = process.env.ADMIN_API_KEY;
  if (adminKey === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = adminKey;

  const { res, state } = fakeRes();
  let nexted = false;
  try {
    requireAdmin({ headers } as never, res as never, () => { nexted = true; });
  } finally {
    if (prior === undefined) delete process.env.ADMIN_API_KEY;
    else process.env.ADMIN_API_KEY = prior;
  }
  return { ...state, nexted };
}

test.describe("auth — the heartbeat router is behind requireAdmin", () => {
  test.it("500s fail-closed when ADMIN_API_KEY is unset", () => {
    const r = runGate({ "x-admin-key": "anything" }, undefined);
    assert.equal(r.code, 500);
    assert.equal(r.nexted, false);
  });

  test.it("403s with no header", () => {
    const r = runGate({}, "the-real-key");
    assert.equal(r.code, 403);
    assert.equal(r.nexted, false);
  });

  test.it("403s with the wrong key", () => {
    const r = runGate({ "x-admin-key": "guess" }, "the-real-key");
    assert.equal(r.code, 403);
    assert.equal(r.nexted, false);
  });

  test.it("403s when the caller sends an empty header against an unset expectation", () => {
    // The empty-matches-empty hole, closed: unset is checked BEFORE the header.
    const r = runGate({ "x-admin-key": "" }, undefined);
    assert.equal(r.code, 500);
    assert.equal(r.nexted, false);
  });

  test.it("passes only on the exact key", () => {
    const r = runGate({ "x-admin-key": "the-real-key" }, "the-real-key");
    assert.equal(r.nexted, true);
    assert.equal(r.code, undefined);
  });
});

// ── Query parsing ────────────────────────────────────────────────────────

test.describe("parseHeartbeatQuery", () => {
  test.it("defaults an empty query", () => {
    assert.deepEqual(parseHeartbeatQuery({}), {
      limit: DEFAULT_HEARTBEAT_LIMIT,
      tickName: null,
      since: null,
      until: null,
    });
  });

  test.it("accepts a limit and clamps it to the ceiling", () => {
    assert.equal(parseHeartbeatQuery({ limit: "10" }).limit, 10);
    assert.equal(parseHeartbeatQuery({ limit: "100000" }).limit, MAX_HEARTBEAT_LIMIT);
  });

  test.it("falls back rather than 400s on garbage — this is an observability endpoint", () => {
    assert.equal(parseHeartbeatQuery({ limit: "abc" }).limit, DEFAULT_HEARTBEAT_LIMIT);
    assert.equal(parseHeartbeatQuery({ limit: "-5" }).limit, DEFAULT_HEARTBEAT_LIMIT);
    assert.equal(parseHeartbeatQuery({ limit: "0" }).limit, DEFAULT_HEARTBEAT_LIMIT);
  });

  test.it("accepts either spelling of the tick filter", () => {
    assert.equal(parseHeartbeatQuery({ tick: "process_due" }).tickName, "process_due");
    assert.equal(parseHeartbeatQuery({ tickName: "fast_tick" }).tickName, "fast_tick");
  });

  test.it("rejects an over-long tick name — a caller sending that is probing", () => {
    assert.equal(parseHeartbeatQuery({ tick: "x".repeat(500) }).tickName, null);
  });

  test.it("ignores a non-string tick (array-style query pollution)", () => {
    assert.equal(parseHeartbeatQuery({ tick: ["a", "b"] }).tickName, null);
    assert.equal(parseHeartbeatQuery({ tick: { $ne: null } }).tickName, null);
  });

  test.it("parses date bounds and drops unparseable ones", () => {
    assert.equal(
      parseHeartbeatQuery({ since: "2026-08-01T00:00:00Z" }).since?.toISOString(),
      "2026-08-01T00:00:00.000Z",
    );
    assert.equal(parseHeartbeatQuery({ since: "yesterday-ish" }).since, null);
    assert.equal(parseHeartbeatQuery({ until: "" }).until, null);
  });
});

// ── Redaction ────────────────────────────────────────────────────────────

test.describe("redactString — token shapes", () => {
  const cases: Array<[string, string]> = [
    ["an OAuth bearer header", "Authorization: Bearer ya29.a0AfH6SMBx-notreal-value-here"],
    ["a bare Google access token", "request failed with ya29.A0ARrdaM9notarealtoken_value"],
    ["a Google refresh token", "refresh failed for 1//0gLongRefreshTokenValueHere_x"],
    ["a JWT", "id_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghij"],
    ["a query-string secret", "GET /token?client_secret=GOCSPX-notarealclientsecret"],
    ["a prefixed secret", "connection string used npg_NotARealNeonPasswordHere"],
    ["inline URL credentials", "postgresql://neondb_owner:hunter2@host.neon.tech/db"],
    ["a basic auth header", "Authorization: Basic dXNlcjpwYXNzd29yZA=="],
  ];

  for (const [label, input] of cases) {
    test.it(`redacts ${label}`, () => {
      const out = redactString(input);
      assert.ok(out.includes(REDACTED), `expected a redaction marker in: ${out}`);
      assert.ok(!out.includes("ya29.a0AfH6SMBx"), out);
      assert.ok(!out.includes("0gLongRefreshTokenValueHere"), out);
      assert.ok(!out.includes("GOCSPX-notarealclientsecret"), out);
      assert.ok(!out.includes("npg_NotARealNeonPassword"), out);
      assert.ok(!out.includes("hunter2"), out);
      assert.ok(!out.includes("dXNlcjpwYXNzd29yZA"), out);
    });
  }

  test.it("leaves ordinary error text alone — redaction must not destroy the signal", () => {
    const msg = "invalid_grant: Token has been expired or revoked.";
    assert.equal(redactString(msg), msg);
  });

  test.it("leaves an email address alone — the operator needs to know WHICH account", () => {
    assert.equal(redactString("ingest failed for murat@mobupps.com"), "ingest failed for murat@mobupps.com");
  });

  test.it("is repeatable — module-level /g regexes must not carry lastIndex between calls", () => {
    const input = "Bearer ya29.aaaaaaaaaaaaaaaaaaaa and Bearer ya29.bbbbbbbbbbbbbbbbbbbb";
    const first = redactString(input);
    for (let i = 0; i < 5; i++) {
      assert.equal(redactString(input), first, "a stateful regex would give a different answer each call");
    }
    assert.ok(!first.includes("ya29.a"), first);
    assert.ok(!first.includes("ya29.b"), first);
  });

  test.it("caps a monstrous string", () => {
    const out = redactString("x".repeat(50_000));
    assert.ok(out.length <= 2000, `length was ${out.length}`);
  });
});

test.describe("redactHeartbeatDetails — the whole payload", () => {
  test.it("redacts a value by its KEY, whatever it contains", () => {
    const out = redactHeartbeatDetails({
      refresh_token: "anything at all",
      apiKey: "abc",
      Authorization: "x",
      sessionSecret: "y",
      cookie: "z",
    }) as Record<string, unknown>;
    for (const k of Object.keys(out)) assert.equal(out[k], REDACTED, k);
  });

  test.it("keeps the counts an operator actually reads", () => {
    const details = { synced: 12, repliesDetected: 3, autoQueued: 7, strandedGenerating: 2, skipped: false };
    assert.deepEqual(redactHeartbeatDetails(details), details);
  });

  test.it("walks into the perUser array and cleans the raw provider errors", () => {
    const details = {
      synced: 0,
      perUser: [
        { userId: 5, email: "murat@mobupps.com", synced: 0, authFailure: true,
          ingestError: "unauthorized_client — config: {Authorization: Bearer ya29.LEAKEDVALUEHERE}" },
        { userId: 7, email: "shama@mobupps.com", synced: 4 },
      ],
    };
    const out = JSON.stringify(redactHeartbeatDetails(details));
    assert.ok(!out.includes("ya29.LEAKEDVALUEHERE"), out);
    assert.ok(out.includes("unauthorized_client"), "the diagnosis must survive redaction");
    assert.ok(out.includes("murat@mobupps.com"), "the account must stay identifiable");
    assert.ok(out.includes(REDACTED));
  });

  test.it("bounds depth — a serialised axios error cannot become a megabyte", () => {
    let deep: Record<string, unknown> = { token: "ya29.deepvalue" };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const out = JSON.stringify(redactHeartbeatDetails(deep));
    assert.ok(out.includes("[depth-limited]"));
    assert.ok(!out.includes("ya29.deepvalue"));
  });

  test.it("bounds array width and says so", () => {
    const out = redactHeartbeatDetails(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    assert.ok(out.length <= 201);
    assert.equal(out[out.length - 1], "[300 more truncated]");
  });

  test.it("survives a circular payload without throwing", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    assert.doesNotThrow(() => JSON.stringify(redactHeartbeatDetails(circular)));
  });

  test.it("passes nulls through — most heartbeats have no details", () => {
    assert.equal(redactHeartbeatDetails(null), null);
    assert.equal(redactHeartbeatDetails(undefined), null);
  });

  test.it("total: never throws on any exotic value", () => {
    for (const v of [Symbol("x"), () => {}, 10n, NaN, Infinity, new Date()]) {
      assert.doesNotThrow(() => redactHeartbeatDetails(v));
    }
  });

  test.it("FULL SWEEP: no known token shape survives anywhere in a realistic payload", () => {
    const details = {
      syncError: "Bearer ya29.AAAAAAAAAAAAAAAAAAAAAA",
      perUser: [{ replyError: "refresh 1//0AAAAAAAAAAAAAAAAAAAA failed" }],
      nested: { deeper: { config: { url: "https://x/y?access_token=SECRETSECRETSECRET" } } },
      client_secret: "GOCSPX-aaaaaaaaaaaaaaaa",
    };
    const out = JSON.stringify(redactHeartbeatDetails(details));
    for (const leak of ["ya29.AAAA", "1//0AAAA", "SECRETSECRETSECRET", "GOCSPX-aaaa"]) {
      assert.ok(!out.includes(leak), `${leak} leaked in ${out}`);
    }
  });
});
