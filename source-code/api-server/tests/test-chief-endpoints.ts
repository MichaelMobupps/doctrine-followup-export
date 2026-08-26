/**
 * test-chief-endpoints.ts — F-3.7a.
 *
 * `GET /api/chief/status` and `GET /api/chief/accounts`, driven over real HTTP
 * against the real router, with the database readers INJECTED.
 *
 * Why injected rather than mocked at the module level: `createChiefRouter()`
 * takes its facts as an argument precisely so the auth, the shaping, the byte
 * ceiling and the 503 path can all be exercised without a Postgres. Everything
 * below is the production code path except the six functions that would
 * otherwise be `SELECT`s.
 *
 * Hermetic despite booting express:
 *   - `DATABASE_URL` is an unroutable dummy set BEFORE any import, because
 *     `routes/chief.ts` pulls in `lib/chiefReaders.ts`, which imports
 *     `@workspace/db`, which throws at import when it is unset. The pool is
 *     lazy and no injected source queries, so nothing connects. The import is
 *     dynamic for the same reason `test-legacy-redirect-http.ts` makes its one
 *     dynamic: a static import is hoisted above these assignments.
 *   - `NODE_ENV=production` + `LOG_LEVEL=silent` keep the `pino-pretty`
 *     transport (a worker thread that can outlive the test) from hanging the
 *     runner.
 *   - port 0, so it cannot contend with the running workflow.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-chief-endpoints.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.DATABASE_URL = "postgresql://f37a:f37a@127.0.0.1:1/none-this-test-never-queries";
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "silent";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// Types come from the static type graph; only the VALUES are imported
// dynamically, so nothing runs before the environment above is in place.
type ChiefSources = import("../routes/chief").ChiefSources;
type AccountRow = import("../lib/chiefView").AccountRow;

const express = (await import("express")).default;
const { createChiefRouter } = await import("../routes/chief");
const {
  ACCOUNTS_PAGE_BYTE_BUDGET,
  MAX_LABEL_CHARS,
  accountLabel,
  accountState,
  containsEmail,
} = await import("../lib/chiefView");

const NOW = new Date("2026-08-11T09:30:00.000Z");

function account(over: Partial<AccountRow> & { id: number }): AccountRow {
  return {
    label: `Account ${over.id}`,
    state: "connected",
    paused_by_admin: false,
    auth_dead_since: null,
    auth_dead_reason: null,
    last_send_at: null,
    queue_depth: 0,
    ...over,
  };
}

/** A truthful fixture: one healthy, one auth-dead, one admin-paused, one gone. */
const FIXTURE: AccountRow[] = [
  account({ id: 1, label: "Michael", last_send_at: "2026-08-11T07:05:00.000Z", queue_depth: 4 }),
  account({
    id: 2,
    label: "Dana",
    state: "auth_dead",
    auth_dead_since: "2026-07-31",
    auth_dead_reason: "unauthorized_client",
    last_send_at: "2026-07-31T06:00:00.000Z",
    queue_depth: 11,
  }),
  account({ id: 3, label: "Yossi", state: "paused", paused_by_admin: true, queue_depth: 2 }),
  account({ id: 4, label: "Account 4", state: "disconnected" }),
];

function sourcesFrom(over: Partial<ChiefSources> = {}): ChiefSources {
  return {
    now: () => NOW,
    env: { FOLLOWUP_CHIEF_TOKEN: TOKEN } as NodeJS.ProcessEnv,
    spendTodayUsd: async () => 12.345678,
    budgetDay: async () => ({
      timeZone: "Asia/Jerusalem",
      windowStartUtc: new Date("2026-08-10T21:00:00.000Z"),
      spentUsd: 14.5,
      capUsd: 500,
      enabled: true,
      exceeded: false,
    }),
    globalPause: async () => false,
    census: async () => ({ connected: 1, auth_dead: 1, paused: 1, disconnected: 1, total: 4 }),
    dueQueueDepth: async () => 17,
    cronPulses: async () => [
      {
        tick_name: "fast_tick",
        last_fired_at: "2026-08-11T09:29:00.000Z",
        age_seconds: 60,
        // F-3.7c: a healthy tick keeps both ages small — it fired a minute ago
        // and the firing before that one finished.
        result_age_seconds: 240,
        ticks_24h: 480,
        errors_24h: 0,
      },
      {
        // A week stale. This is the tick whose age the "oldest heartbeat"
        // headline has to surface; if the headline took the newest instead,
        // every card would look alive while a cron was dead.
        tick_name: "weekly_digest",
        last_fired_at: "2026-08-04T00:00:00.000Z",
        age_seconds: 639_000,
        result_age_seconds: 639_000,
        ticks_24h: 0,
        errors_24h: 0,
      },
    ],
    accountsSlice: async (limit, offset) => ({
      rows: FIXTURE.slice(offset, offset + limit),
      total: FIXTURE.length,
    }),
    ...over,
  };
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  text: string;
}

async function serve(sources: ChiefSources): Promise<{
  get(path: string, headers?: Record<string, string>): Promise<Reply>;
  post(path: string, headers?: Record<string, string>): Promise<Reply>;
  close(): Promise<void>;
}> {
  const app = express();
  app.use("/api/chief", createChiefRouter(sources));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const call = async (
    method: string,
    path: string,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    return { status: res.status, headers: out, text: await res.text() };
  };

  return {
    get: (p, h) => call("GET", p, h),
    post: (p, h) => call("POST", p, h),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

test.describe("auth is indistinguishable, and no-store is on every path", () => {
  test.it("every auth failure returns byte-identical bytes", async () => {
    const s = await serve(sourcesFrom());
    try {
      const cases: Array<[string, string, Record<string, string>]> = [
        ["no header", "/api/chief/status", {}],
        ["empty header", "/api/chief/status", { authorization: "" }],
        ["lower-case scheme", "/api/chief/status", { authorization: `bearer ${TOKEN}` }],
        ["wrong scheme", "/api/chief/status", { authorization: `Basic ${TOKEN}` }],
        ["wrong token, same length", "/api/chief/status", { authorization: `Bearer ${"f".repeat(64)}` }],
        ["wrong token, other length", "/api/chief/status", { authorization: "Bearer nope" }],
        ["bare token, no scheme", "/api/chief/status", { authorization: TOKEN }],
        ["wrong path, no token", "/api/chief/nope", {}],
        ["wrong path, wrong token", "/api/chief/nope", { authorization: "Bearer nope" }],
        ["accounts, wrong token", "/api/chief/accounts", { authorization: "Bearer nope" }],
      ];
      const seen = new Set<string>();
      for (const [label, path, headers] of cases) {
        const r = await s.get(path, headers);
        assert.equal(r.status, 401, label);
        assert.equal(r.text, '{"error":"valid order-token required"}', label);
        assert.equal(r.headers["cache-control"], "no-store", label);
        seen.add(`${r.status} ${r.text}`);
      }
      assert.equal(seen.size, 1, "every auth failure must be one response, not a family");
    } finally {
      await s.close();
    }
  });

  test.it("a VALID token on an unknown path gets the same 401 — the 401 enumerates nothing", async () => {
    // A deliberate departure from the Chief's own §5 (where a 404 proves your
    // token was accepted). Stated in the contract, because it means a path typo
    // reads as `token rejected` while wiring.
    const s = await serve(sourcesFrom());
    try {
      const r = await s.get("/api/chief/does-not-exist", AUTH);
      assert.equal(r.status, 401);
      assert.equal(r.text, '{"error":"valid order-token required"}');
    } finally {
      await s.close();
    }
  });

  test.it("a valid token on a WRONG METHOD gets the same 401, not a 404 or a 405", async () => {
    const s = await serve(sourcesFrom());
    try {
      const r = await s.post("/api/chief/status", AUTH);
      assert.equal(r.status, 401);
      assert.equal(r.text, '{"error":"valid order-token required"}');
    } finally {
      await s.close();
    }
  });

  test.it("everything 401s when the app has no token configured, including a blank Bearer", async () => {
    const s = await serve(sourcesFrom({ env: {} as NodeJS.ProcessEnv }));
    try {
      for (const h of [AUTH, { authorization: "Bearer " }, {}]) {
        const r = await s.get("/api/chief/status", h);
        assert.equal(r.status, 401);
        assert.equal(r.text, '{"error":"valid order-token required"}');
      }
    } finally {
      await s.close();
    }
  });
});

test.describe("GET /api/chief/status", () => {
  test.it("answers 200 with the card fields the Chief reads, and no-store", async () => {
    const s = await serve(sourcesFrom());
    try {
      const r = await s.get("/api/chief/status", AUTH);
      assert.equal(r.status, 200);
      assert.equal(r.headers["cache-control"], "no-store");
      const b = JSON.parse(r.text);
      assert.equal(b.app, "followup");
      assert.equal(b.ok, true);
      assert.equal(b.version, "f-3.7a");
      assert.equal(b.server_time, NOW.toISOString());
      assert.equal(b.spend_today_usd, 12.345678);
    } finally {
      await s.close();
    }
  });

  test.it("OMITS accepting_jobs and active_jobs, and says why in `capabilities`", async () => {
    // The Chief renders a dash for a field it did not receive and records the
    // absence in `fields_present`. That is the designed way to say "this
    // question does not apply to me"; sending `accepting_jobs: false` would
    // render as a temporary condition somebody should go fix.
    const s = await serve(sourcesFrom());
    try {
      const b = JSON.parse((await s.get("/api/chief/status", AUTH)).text);
      assert.equal("accepting_jobs" in b, false);
      assert.equal("active_jobs" in b, false);
      assert.deepEqual(b.capabilities, {
        accepts_jobs: false,
        health_pulse: true,
        spend_reporting: "outbound",
        chief_writes: false,
        reply_intelligence: false,
      });
    } finally {
      await s.close();
    }
  });

  test.it("carries the health summary the order asks for", async () => {
    const s = await serve(sourcesFrom());
    try {
      const b = JSON.parse((await s.get("/api/chief/status", AUTH)).text);
      assert.deepEqual(b.health.accounts, {
        connected: 1,
        auth_dead: 1,
        paused: 1,
        disconnected: 1,
        total: 4,
      });
      assert.equal(b.health.due_queue_depth, 17);
      assert.equal(b.health.sending_paused_globally, false);
      assert.equal(b.health.crons.length, 2);
      // The "oldest heartbeat" is the WORST per-tick age, not the newest.
      assert.equal(
        b.health.oldest_heartbeat_age_seconds,
        Math.max(...b.health.crons.map((c: { age_seconds: number }) => c.age_seconds)),
      );
    } finally {
      await s.close();
    }
  });

  test.it("reports both day windows, because they are genuinely different hours", async () => {
    const s = await serve(sourcesFrom());
    try {
      const b = JSON.parse((await s.get("/api/chief/status", AUTH)).text);
      assert.equal(b.budget.utc_day_start, "2026-08-11T00:00:00.000Z");
      assert.equal(b.budget.app_budget_day.time_zone, "Asia/Jerusalem");
      assert.equal(b.budget.app_budget_day.window_start_utc, "2026-08-10T21:00:00.000Z");
      assert.equal(b.budget.app_budget_day.spent_usd, 14.5);
      assert.equal(b.budget.app_budget_day.cap_usd, 500);
      assert.notEqual(b.budget.utc_day_start, b.budget.app_budget_day.window_start_utc);
    } finally {
      await s.close();
    }
  });

  test.it("answers 503 rather than a fabricated zero when a read fails", async () => {
    for (const broken of ["spendTodayUsd", "census", "dueQueueDepth", "cronPulses", "budgetDay", "globalPause"] as const) {
      const s = await serve(
        sourcesFrom({
          [broken]: async () => {
            throw new Error("database is down");
          },
        } as Partial<ChiefSources>),
      );
      try {
        const r = await s.get("/api/chief/status", AUTH);
        assert.equal(r.status, 503, broken);
        assert.equal(r.text, '{"error":"status unavailable"}', broken);
        assert.equal(r.headers["cache-control"], "no-store", broken);
      } finally {
        await s.close();
      }
    }
  });

  test.it("the 503 body says nothing about the underlying error", async () => {
    const s = await serve(
      sourcesFrom({
        census: async () => {
          throw new Error("connection to 10.1.2.3:5432 refused for user npg_secret");
        },
      }),
    );
    try {
      const r = await s.get("/api/chief/status", AUTH);
      assert.equal(r.text, '{"error":"status unavailable"}');
      assert.ok(!r.text.includes("npg_secret"));
    } finally {
      await s.close();
    }
  });
});

test.describe("GET /api/chief/accounts", () => {
  test.it("renders the truthful fixture, auth-dead and paused included", async () => {
    const s = await serve(sourcesFrom());
    try {
      const r = await s.get("/api/chief/accounts", AUTH);
      assert.equal(r.status, 200);
      assert.equal(r.headers["cache-control"], "no-store");
      const b = JSON.parse(r.text);
      assert.equal(b.app, "followup");
      assert.equal(b.page.total, 4);
      assert.equal(b.page.returned, 4);
      assert.equal(b.page.next_offset, null);
      assert.deepEqual(
        b.accounts.map((a: { state: string }) => a.state),
        ["connected", "auth_dead", "paused", "disconnected"],
      );
      const dead = b.accounts[1];
      assert.equal(dead.auth_dead_since, "2026-07-31");
      assert.equal(dead.auth_dead_reason, "unauthorized_client");
      assert.equal(dead.queue_depth, 11);
      assert.equal(b.accounts[2].paused_by_admin, true);
    } finally {
      await s.close();
    }
  });

  test.it("pages, and next_offset walks the whole set exactly once", async () => {
    const s = await serve(sourcesFrom());
    try {
      const seen: number[] = [];
      let offset: number | null = 0;
      let hops = 0;
      while (offset !== null && hops < 10) {
        hops += 1;
        const b: {
          page: { next_offset: number | null; returned: number };
          accounts: Array<{ id: number }>;
        } = JSON.parse((await s.get(`/api/chief/accounts?limit=2&offset=${offset}`, AUTH)).text);
        seen.push(...b.accounts.map((a) => a.id));
        offset = b.page.next_offset;
      }
      assert.deepEqual(seen, [1, 2, 3, 4]);
      assert.equal(hops, 2);
    } finally {
      await s.close();
    }
  });

  test.it("garbage paging falls back to the defaults rather than 400-ing", async () => {
    const s = await serve(sourcesFrom());
    try {
      const b = JSON.parse((await s.get("/api/chief/accounts?limit=banana&offset=-5", AUTH)).text);
      assert.equal(b.page.limit, 50);
      assert.equal(b.page.offset, 0);
    } finally {
      await s.close();
    }
  });

  test.it("clamps an outsized limit", async () => {
    const s = await serve(sourcesFrom());
    try {
      const b = JSON.parse((await s.get("/api/chief/accounts?limit=99999", AUTH)).text);
      assert.equal(b.page.limit, 200);
    } finally {
      await s.close();
    }
  });

  test.it("STAYS UNDER THE CHIEF'S 64 KB CEILING at the worst case, and pages the rest", async () => {
    // 200 accounts (the hard limit) each with a maximum-length label and every
    // optional field populated. If this ever exceeds 64 KB the Chief reports the
    // app as `bad_response` — "unreachable" for an app that answered perfectly.
    const fat: AccountRow[] = Array.from({ length: 200 }, (_, i) =>
      account({
        id: 100000 + i,
        label: "W".repeat(MAX_LABEL_CHARS),
        state: "auth_dead",
        paused_by_admin: true,
        auth_dead_since: "2026-07-31",
        auth_dead_reason: "unauthorized_client",
        last_send_at: "2026-07-31T06:00:00.000Z",
        queue_depth: 999999,
      }),
    );
    const s = await serve(
      sourcesFrom({
        accountsSlice: async (limit, offset) => ({
          rows: fat.slice(offset, offset + limit),
          total: fat.length,
        }),
      }),
    );
    try {
      const r = await s.get("/api/chief/accounts?limit=200", AUTH);
      const bytes = Buffer.byteLength(r.text, "utf8");
      assert.ok(bytes <= 64 * 1024, `page was ${bytes} bytes, over the Chief's hard ceiling`);
      assert.ok(bytes <= ACCOUNTS_PAGE_BYTE_BUDGET, `page was ${bytes} bytes, over our own budget`);

      // Whatever the packer dropped, it said so — a caller following
      // `next_offset` still reaches every row.
      const b = JSON.parse(r.text);
      assert.equal(b.accounts.length, b.page.returned);
      if (b.page.returned < b.page.total) {
        assert.equal(b.page.next_offset, b.page.returned);
      }
    } finally {
      await s.close();
    }
  });

  test.it("packs to the budget when the budget is tiny — the ceiling is measured, not assumed", async () => {
    // Drive the packer against a budget small enough that it must drop rows,
    // and prove it never lies about how many it kept.
    const { packAccountsPage } = await import("../lib/chiefView");
    const page = packAccountsPage({
      rows: FIXTURE,
      limit: 50,
      offset: 0,
      total: FIXTURE.length,
      serverTime: NOW.toISOString(),
      appName: "followup",
      byteBudget: 420,
    });
    assert.ok(page.accounts.length < FIXTURE.length, "the tiny budget must have bitten");
    assert.equal(page.page.returned, page.accounts.length);
    assert.equal(page.page.next_offset, page.accounts.length);
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 420);
  });

  test.it("a page always ADVANCES, even when one row alone blows the budget", async () => {
    // The failure this pins is a hang in somebody else's process, not a wrong
    // number: a page that returns zero rows while rows remain sets
    // `next_offset` back to its own `offset`, and a caller following
    // `next_offset` walks that page for ever.
    const { packAccountsPage } = await import("../lib/chiefView");
    let offset = 0;
    const visited = new Set<number>();
    for (let hop = 0; hop < 20 && offset !== null && offset < FIXTURE.length; hop++) {
      const page: {
        page: { next_offset: number | null; returned: number };
        accounts: Array<{ id: number }>;
      } = packAccountsPage({
        rows: FIXTURE.slice(offset),
        limit: 50,
        offset,
        total: FIXTURE.length,
        serverTime: NOW.toISOString(),
        appName: "followup",
        byteBudget: 1, // no page can satisfy this
      });
      assert.equal(page.page.returned, 1, "one row is kept rather than none");
      page.accounts.forEach((a) => visited.add(a.id));
      const next: number | null = page.page.next_offset;
      assert.notEqual(next, offset, "the walk must move");
      if (next === null) break;
      offset = next;
    }
    assert.equal(visited.size, FIXTURE.length, "every row is still reachable");
  });
});

test.describe("identity discipline — no email address ever reaches the wire", () => {
  test.it("a name that IS an email becomes a positional label", () => {
    assert.equal(accountLabel(7, "michael.a.g@mobupps.com"), "Account 7");
    assert.equal(accountLabel(7, "  Dana <dana@mobupps.com>  "), "Account 7");
    assert.equal(accountLabel(7, "someone@localhost"), "Account 7");
  });

  test.it("an ordinary name survives, bounded and de-controlled", () => {
    assert.equal(accountLabel(7, "Michael"), "Michael");
    assert.equal(accountLabel(7, "  Michael\nGoldstein  "), "Michael Goldstein");
    assert.equal(accountLabel(7, "M".repeat(500)).length, MAX_LABEL_CHARS);
  });

  test.it("bounds by code point, so a long label cannot end in half a character", () => {
    const label = accountLabel(7, "😀".repeat(100));
    assert.equal(Array.from(label).length, MAX_LABEL_CHARS);
    // A lone surrogate survives JSON.stringify as an escape rather than
    // throwing, so the failure this pins is a `\udXXX` in an operator's console.
    assert.equal(JSON.parse(JSON.stringify({ label })).label, label);
    assert.ok(!/[\uD800-\uDFFF]/.test(label.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")));
  });

  test.it("an empty or missing name becomes a positional label", () => {
    assert.equal(accountLabel(7, ""), "Account 7");
    assert.equal(accountLabel(7, null), "Account 7");
    assert.equal(accountLabel(7, "   "), "Account 7");
  });

  test.it("no response body in this suite contains an email address", async () => {
    const s = await serve(sourcesFrom());
    try {
      for (const path of ["/api/chief/status", "/api/chief/accounts", "/api/chief/nope"]) {
        for (const h of [AUTH, {}]) {
          const r = await s.get(path, h);
          assert.equal(containsEmail(r.text), false, `${path} leaked an address`);
        }
      }
    } finally {
      await s.close();
    }
  });

  test.it("the payload guard 503s rather than shipping an address that got past the label rule", async () => {
    // The label rule is the guarantee. This is the second, independent check
    // over the finished bytes, so the property is structural: a future mapper
    // that puts an address in a new field cannot ship it.
    const s = await serve(
      sourcesFrom({
        accountsSlice: async () => ({
          rows: [account({ id: 1, label: "leaked.person@mobupps.com" })],
          total: 1,
        }),
      }),
    );
    try {
      const r = await s.get("/api/chief/accounts", AUTH);
      assert.equal(r.status, 503);
      assert.equal(r.text, '{"error":"status unavailable"}');
      assert.equal(containsEmail(r.text), false);
    } finally {
      await s.close();
    }
  });
});

test.describe("the spend reporter is dormant and loud when unconfigured", () => {
  test.it("takes the dormant branch, registers no tick, and says so exactly once", async () => {
    // Imported here rather than at the top because it pulls in `@workspace/db`;
    // the dummy DATABASE_URL above is what makes that import legal, and the
    // dormant branch returns before any query could be issued.
    const { startChiefSpendReporting, _resetChiefSpendReporting, CHIEF_DORMANT_MESSAGE } =
      await import("../lib/chiefSpendSweep");
    for (const v of ["CHIEF_URL", "CHIEF_INGEST_TOKEN"]) delete process.env[v];
    _resetChiefSpendReporting();
    assert.equal(startChiefSpendReporting(), "dormant");
    assert.equal(startChiefSpendReporting(), "already_started");
    assert.ok(CHIEF_DORMANT_MESSAGE.includes("DORMANT"));
    assert.ok(CHIEF_DORMANT_MESSAGE.includes("CHIEF_URL"));
    assert.ok(CHIEF_DORMANT_MESSAGE.includes("CHIEF_INGEST_TOKEN"));
    _resetChiefSpendReporting();
  });
});

test.describe("accountState precedence", () => {
  test.it("auth_dead OUTRANKS paused — an admin pause can never hide a dead grant", () => {
    assert.equal(
      accountState({ isConnected: true, authDeadAt: new Date(), pausedByAdmin: true }),
      "auth_dead",
    );
  });

  test.it("disconnected wins over everything, because there is no grant to be dead", () => {
    assert.equal(
      accountState({ isConnected: false, authDeadAt: new Date(), pausedByAdmin: true }),
      "disconnected",
    );
  });

  test.it("the ordinary three", () => {
    assert.equal(accountState({ isConnected: true, authDeadAt: null, pausedByAdmin: false }), "connected");
    assert.equal(accountState({ isConnected: true, authDeadAt: null, pausedByAdmin: true }), "paused");
    assert.equal(accountState({ isConnected: true, authDeadAt: new Date(), pausedByAdmin: false }), "auth_dead");
  });
});
