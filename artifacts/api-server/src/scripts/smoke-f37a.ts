/**
 * smoke-f37a.ts — F-3.7a live smoke, against an ISOLATED database.
 *
 * Exercises the real router, the real readers and the real spend accounting
 * against a real Postgres, in both modes:
 *
 *   DARK — `FOLLOWUP_CHIEF_TOKEN`, `CHIEF_URL` and `CHIEF_INGEST_TOKEN` all
 *          absent. This is production TODAY: the seam exists in the build and
 *          is answerable by nobody. Every probe must 401, and the reporter must
 *          be dormant, loud and harmless.
 *   LIT  — all three PRESENT. The Chief can read the card and the accounts
 *          page, and spend is reported in $0.50 quanta.
 *
 * ── VENDORS ARE MADE IMPOSSIBLE, NOT MERELY UNLIKELY ──────────────────────
 *
 * `http.request`, `https.request`, `http.get`, `https.get` and
 * `globalThis.fetch` are replaced with throwers BEFORE any application module
 * is loaded. Postgres speaks over `net`/`tls` and is unaffected. Any outbound
 * call — Gmail, Anthropic, Gemini, the real Chief — becomes a loud,
 * attributable exception instead of a request.
 *
 * Two things still need to move bytes, and each is handled by construction
 * rather than by exception:
 *
 *   - the smoke's own requests to the app it booted. A LOOPBACK-ONLY fetch is
 *     captured before the lockout and refuses any host but 127.0.0.1, so the
 *     escape hatch cannot be pointed at the internet even by accident.
 *   - the spend reporter. It is handed a FAKE CHIEF as `fetchImpl`, so it opens
 *     no socket at all — and because the global `fetch` is a thrower, a reporter
 *     built without that injection would fail loudly rather than reach the real
 *     Chief.
 *
 * NOTHING HERE SENDS EMAIL. No scheduler entry point is called, no Gmail client
 * is constructed, and the transport is dead anyway.
 *
 * ── USAGE — never point this at dev or production ─────────────────────────
 *
 *   # one isolated database per mode, each a copy of the dev SCHEMA with
 *   # chief_spend_cursor deliberately removed, so the new migration is exercised
 *   createdb f37a_smoke_dark
 *   pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" | psql -q f37a_smoke_dark
 *   psql -q f37a_smoke_dark -c 'DROP TABLE IF EXISTS chief_spend_cursor'
 *
 *   SMOKE_MODE=dark DATABASE_URL=postgresql://…/f37a_smoke_dark \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/smoke-f37a.ts
 *
 *   # then the same for f37a_smoke_lit with SMOKE_MODE=lit, and dropdb both
 *
 * It refuses to run against a database whose name does not contain "smoke" or
 * "test".
 */

import { createRequire } from "node:module";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ── 1. Transport lockout. Nothing application-level is loaded yet. ─────────
//
// The CJS module objects, not the ESM namespaces: an `import * as https`
// namespace is frozen, and it is the CJS object that `gaxios` and every other
// client resolve `request`/`get` from at call time.
const require = createRequire(import.meta.url);
const httpMod = require("node:http") as Record<string, unknown>;
const httpsMod = require("node:https") as Record<string, unknown>;

let vendorAttempts = 0;
function blockOutbound(what: string): never {
  vendorAttempts++;
  throw new Error(`SMOKE LOCKOUT: outbound ${what} attempted — this smoke makes no vendor calls`);
}
for (const mod of [httpMod, httpsMod]) {
  mod.request = () => blockOutbound("http(s).request");
  mod.get = () => blockOutbound("http(s).get");
}
const realFetch = globalThis.fetch;
globalThis.fetch = (() => blockOutbound("fetch")) as never;

/** The one way out of this process, and it can only reach the loopback. */
async function loopbackFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1") {
    blockOutbound(`loopbackFetch to ${parsed.hostname}`);
  }
  return realFetch(url, init);
}

// ── 2. Mode and environment. Set BEFORE any application module exists. ─────
const MODE = (process.env.SMOKE_MODE || "dark").toLowerCase();
if (MODE !== "dark" && MODE !== "lit") {
  console.error(`SMOKE_MODE must be "dark" or "lit" (got ${JSON.stringify(process.env.SMOKE_MODE)})`);
  process.exit(2);
}

const TOKEN = "f37a-smoke-order-token-0123456789abcdef0123456789abcdef01234567";
const CHIEF_VARS = ["FOLLOWUP_CHIEF_TOKEN", "CHIEF_URL", "CHIEF_INGEST_TOKEN"] as const;

if (MODE === "dark") {
  for (const v of CHIEF_VARS) delete process.env[v];
} else {
  process.env.FOLLOWUP_CHIEF_TOKEN = TOKEN;
  process.env.CHIEF_INGEST_TOKEN = TOKEN;
  // Obviously fake AND unreachable: the transport is dead, and the reporter is
  // handed a fake Chief, so this value can only ever be read, never dialled.
  process.env.CHIEF_URL = "https://chief-ship.invalid";
}

// Mirror production: the app is served under the gateway prefix.
process.env.BASE_PATH = "/followup";
process.env.ADDON_API_KEY = "smoke-addon-key";
process.env.ADMIN_API_KEY = "smoke-admin-key";
// Sending is impossible here anyway, but leaving these unset is the F-3.6b
// discipline: no identity of last resort exists to be picked up.
for (const v of ["GOOGLE_REFRESH_TOKEN", "SENDER_EMAIL", "SENDER_NAME"]) delete process.env[v];
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "info";

// ── 3. Now the application. ───────────────────────────────────────────────
const { pool } = await import("@workspace/db");
const { runStartupMigrations } = await import("../lib/startupMigrations");
const { default: app } = await import("../app");
const { EMAIL_LIKE, MAX_LABEL_CHARS } = await import("../lib/chiefView");
const {
  createChiefReporter,
  resolveChiefConfig,
  SPEND_QUANTUM_CENTS,
} = await import("../lib/chiefSpend");
const {
  runChiefSpendSweep,
  startChiefSpendReporting,
  _resetChiefSpendReporting,
  CHIEF_DORMANT_MESSAGE,
} = await import("../lib/chiefSpendSweep");

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
}

/**
 * Every response body this smoke has seen, in order. The leak grep at the end
 * runs over ALL of it — the order asks for the whole HTTP surface, not the two
 * bodies somebody remembered to check.
 */
const capturedBodies: Array<{ what: string; text: string }> = [];

let port = 0;
interface Reply {
  status: number;
  text: string;
  cache: string | null;
}
async function get(path: string, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await loopbackFetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  capturedBodies.push({ what: `GET ${path}`, text });
  return { status: res.status, text, cache: res.headers.get("cache-control") };
}

const AUTH = { authorization: `Bearer ${TOKEN}` };

// ── Fixtures ──────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedTruthfulAccounts(now: Date): Promise<Record<string, number>> {
  const ids: Record<string, number> = {};

  const mk = async (
    email: string,
    name: string,
    isConnected: boolean,
    authDeadAt: Date | null,
    authDeadReason: string | null,
    pausedByAdmin: boolean,
  ): Promise<number> => {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO users (email, name, is_connected, auth_dead_at, auth_dead_reason, paused_by_admin)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [email, name, isConnected, authDeadAt, authDeadReason, pausedByAdmin],
    );
    return r.rows[0].id;
  };

  ids.healthy = await mk("healthy@smoke.invalid", "Michael", true, null, null, false);
  // The account this whole endpoint exists for: a grant Google refuses, dead
  // since before the incident window, still reporting `is_connected`.
  ids.dead = await mk(
    "dead@smoke.invalid",
    "Dana",
    true,
    new Date(now.getTime() - 11 * DAY_MS),
    "unauthorized_client",
    false,
  );
  ids.paused = await mk("paused@smoke.invalid", "Yossi", true, null, null, true);
  ids.gone = await mk("gone@smoke.invalid", "", false, null, null, false);
  // The identity trap: an account whose NAME is its address. If the label rule
  // ever stops failing closed, this row is what carries the address onto the
  // wire — and the leak grep at the end is what catches it.
  ids.nameIsEmail = await mk(
    "nameisemail@smoke.invalid",
    "nameisemail@smoke.invalid",
    true,
    null,
    null,
    false,
  );
  // Both at once: admin-paused AND auth-dead. `state` must say `auth_dead`.
  ids.deadAndPaused = await mk(
    "both@smoke.invalid",
    "Both",
    true,
    new Date(now.getTime() - 3 * DAY_MS),
    "invalid_grant",
    true,
  );

  // Campaigns, so `queue_depth` and `last_send_at` are real numbers rather than
  // zeroes that would pass any assertion.
  const mkProspect = async (userId: number, tag: string): Promise<number> => {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO prospects (user_id, gmail_message_id, gmail_thread_id, email, sent_at, app)
       VALUES ($1,$2,$3,$4,$5,'doctrine') RETURNING id`,
      [userId, `msg-${tag}`, `thr-${tag}`, `prospect-${tag}@smoke.invalid`, new Date(now.getTime() - 20 * DAY_MS)],
    );
    return r.rows[0].id;
  };
  const mkFollowup = async (
    prospectId: number,
    stage: number,
    status: string,
    scheduledAt: Date,
    sentAt: Date | null,
  ): Promise<void> => {
    await pool.query(
      `INSERT INTO followups (prospect_id, stage, status, scheduled_at, sent_at) VALUES ($1,$2,$3,$4,$5)`,
      [prospectId, stage, status, scheduledAt, sentAt],
    );
  };

  const pHealthy = await mkProspect(ids.healthy, "healthy");
  await mkFollowup(pHealthy, 1, "sent", new Date(now.getTime() - 5 * DAY_MS), new Date(now.getTime() - 5 * DAY_MS));
  await mkFollowup(pHealthy, 2, "queued", new Date(now.getTime() - 1 * DAY_MS), null);

  const pDead = await mkProspect(ids.dead, "dead");
  await mkFollowup(pDead, 1, "sent", new Date(now.getTime() - 12 * DAY_MS), new Date(now.getTime() - 12 * DAY_MS));
  await mkFollowup(pDead, 2, "queued", new Date(now.getTime() - 2 * DAY_MS), null);
  await mkFollowup(pDead, 3, "queued", new Date(now.getTime() - 1 * DAY_MS), null);

  const pPaused = await mkProspect(ids.paused, "paused");
  await mkFollowup(pPaused, 1, "queued", new Date(now.getTime() - 1 * DAY_MS), null);

  return ids;
}

async function seedHeartbeats(now: Date): Promise<void> {
  await pool.query(
    `INSERT INTO cron_heartbeats (tick_name, fired_at, outcome, duration_ms, details)
     VALUES ('fast_tick', $1, 'ok', 12, '{"note":"recent"}'::jsonb),
            ('sync_and_autoqueue', $2, 'partial', 900, '{"perUser":[{"email":"leak-probe@smoke.invalid"}]}'::jsonb),
            ('weekly_digest', $3, 'ok', 40, NULL)`,
    [
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 20 * 60_000),
      // Deliberately stale, so the "oldest heartbeat" headline has something to
      // find. A card that reports the NEWEST age looks healthy while a cron is
      // a week dead.
      new Date(now.getTime() - 7 * DAY_MS),
    ],
  );
}

/** Usage rows, so the spend accounting has real money to bucket. */
async function seedUsage(model: string, costUsd: number, at: Date): Promise<void> {
  await pool.query(
    `INSERT INTO followup_usage (app, stage, label, model, cost_usd, generated_at)
     VALUES ('doctrine', 1, 'draft', $1, $2, $3)`,
    [model, costUsd.toFixed(6), at],
  );
}

// ── The fake Chief ─────────────────────────────────────────────────────────

interface ChiefRequest {
  vendor: string;
  amountUsd: number;
  externalId: string;
  initiatedBy: string | undefined;
}

/**
 * A stand-in for `POST /api/ingest/spend` with the Chief's REAL dedupe
 * semantics: `(app, external_id)` is the key, a first write is `201`, a repeat
 * is `200 deduped` and writes nothing. Idempotency is therefore demonstrated
 * against the rule the Chief actually applies, not against a stub that agrees
 * with us by construction.
 */
function makeFakeChief() {
  const seenIds = new Set<string>();
  const requests: ChiefRequest[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      vendor: String(body.vendor),
      amountUsd: Number(body.amount_usd),
      externalId: String(body.external_id),
      initiatedBy: body.initiated_by as string | undefined,
    });
    if (seenIds.has(String(body.external_id))) {
      return new Response('{"recorded":true,"deduped":true}', { status: 200 });
    }
    seenIds.add(String(body.external_id));
    return new Response('{"recorded":true,"deduped":false}', { status: 201 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests, rows: () => seenIds.size };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbName = (await pool.query<{ current_database: string }>("select current_database()")).rows[0]
    .current_database;
  if (!/smoke|test/i.test(dbName)) {
    throw new Error(`Refusing to smoke against database "${dbName}" — the name must contain "smoke" or "test".`);
  }
  console.log(`\nF-3.7a smoke — MODE=${MODE} — database "${dbName}"`);

  // ── The migration ────────────────────────────────────────────────────────
  section("startup migration provisions the spend cursor");
  const before = await pool.query<{ n: string }>(
    "select count(*)::text as n from information_schema.tables where table_name = 'chief_spend_cursor'",
  );
  await runStartupMigrations();
  const after = await pool.query<{ n: string }>(
    "select count(*)::text as n from information_schema.tables where table_name = 'chief_spend_cursor'",
  );
  check("chief_spend_cursor exists after boot", after.rows[0].n === "1", after.rows[0].n);
  console.log(`        (it was ${before.rows[0].n === "1" ? "already present" : "absent"} before the migration ran)`);
  const pk = await pool.query<{ conname: string }>(
    "select conname from pg_constraint where conrelid = 'chief_spend_cursor'::regclass and contype = 'p'",
  );
  check(
    "its primary key carries the name drizzle also uses, so the publish diff cannot churn",
    pk.rows[0]?.conname === "chief_spend_cursor_day_key_vendor_pk",
    pk.rows[0]?.conname,
  );
  // Idempotent: a second boot must be a no-op, not an error.
  await runStartupMigrations();
  check("re-running the migration is a no-op", true);

  // ── Fixtures ─────────────────────────────────────────────────────────────
  const now = new Date();
  const ids = await seedTruthfulAccounts(now);
  await seedHeartbeats(now);

  // ── Boot ─────────────────────────────────────────────────────────────────
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  try {
    // ── Auth ───────────────────────────────────────────────────────────────
    section("the 401 is an oracle for nothing");
    const authFailures: Array<[string, Reply]> = [];
    for (const [label, path, headers] of [
      ["no header", "/api/chief/status", {}],
      ["empty header", "/api/chief/status", { authorization: "" }],
      ["malformed header (lower-case scheme)", "/api/chief/status", { authorization: `bearer ${TOKEN}` }],
      ["malformed header (wrong scheme)", "/api/chief/status", { authorization: `Basic ${TOKEN}` }],
      ["malformed header (bare token)", "/api/chief/status", { authorization: TOKEN }],
      ["wrong token, same length", "/api/chief/status", { authorization: `Bearer ${"z".repeat(TOKEN.length)}` }],
      ["wrong token, other length", "/api/chief/status", { authorization: "Bearer nope" }],
      ["valid token, wrong path", "/api/chief/nope", AUTH],
      ["valid token, wrong path (prefixed)", "/followup/api/chief/nope", AUTH],
      ["valid token, wrong method", "/api/chief/accounts/1", AUTH],
      ["addon key only", "/api/chief/status", { "x-api-key": "smoke-addon-key" }],
    ] as Array<[string, string, Record<string, string>]>) {
      authFailures.push([label, await get(path, headers)]);
    }
    const distinct = new Set(authFailures.map(([, r]) => `${r.status}|${r.text}|${r.cache}`));
    check(
      "every auth failure is byte-identical (wrong token, malformed header, valid-token-wrong-path)",
      distinct.size === 1 && [...distinct][0] === `401|{"error":"valid order-token required"}|no-store`,
      [...distinct],
    );

    // ── Status and accounts ────────────────────────────────────────────────
    if (MODE === "dark") {
      section("DARK: the seam exists and answers nobody");
      for (const path of [
        "/api/chief/status",
        "/api/chief/accounts",
        "/followup/api/chief/status",
        "/followup/api/chief/accounts",
      ]) {
        const r = await get(path, AUTH);
        check(
          `${path} 401s even with the LIT token, because no token is configured`,
          r.status === 401 && r.text === '{"error":"valid order-token required"}' && r.cache === "no-store",
          r,
        );
      }
    } else {
      section("LIT: the card");
      const statusReply = await get("/api/chief/status", AUTH);
      check("status answers 200", statusReply.status === 200, statusReply.status);
      check("status is no-store", statusReply.cache === "no-store", statusReply.cache);
      const status = JSON.parse(statusReply.text);
      check("identity is `followup`", status.app === "followup", status.app);
      check("ok is true", status.ok === true);
      check("a version is stated", typeof status.version === "string" && status.version.length > 0);
      check("server_time parses as an instant", !Number.isNaN(Date.parse(status.server_time)));
      check(
        "accepting_jobs and active_jobs are OMITTED, not faked",
        !("accepting_jobs" in status) && !("active_jobs" in status),
        Object.keys(status),
      );
      check(
        "capabilities state the truth instead",
        status.capabilities?.accepts_jobs === false &&
          status.capabilities?.chief_writes === false &&
          status.capabilities?.spend_reporting === "outbound",
        status.capabilities,
      );
      check(
        "the census counts the fixture truthfully",
        status.health.accounts.auth_dead === 2 &&
          status.health.accounts.paused === 1 &&
          status.health.accounts.disconnected === 1 &&
          status.health.accounts.connected === 2 &&
          status.health.accounts.total === 6,
        status.health.accounts,
      );
      check(
        "the due-queue depth is a real number",
        status.health.due_queue_depth === 1,
        status.health.due_queue_depth,
      );
      check(
        "the oldest heartbeat is the WORST tick's age, not the newest",
        status.health.oldest_heartbeat_age_seconds > 6 * 24 * 3600,
        status.health.oldest_heartbeat_age_seconds,
      );
      check(
        "every cron reports a pulse",
        status.health.crons.length === 3,
        status.health.crons.map((c: { tick_name: string }) => c.tick_name),
      );
      check(
        "no heartbeat `details` payload rides along",
        !statusReply.text.includes("perUser"),
      );
      check(
        "both day windows are reported and genuinely differ",
        typeof status.budget.utc_day_start === "string" &&
          status.budget.utc_day_start !== status.budget.app_budget_day.window_start_utc,
        status.budget,
      );

      section("LIT: the accounts page");
      const accountsReply = await get("/api/chief/accounts", AUTH);
      check("accounts answers 200", accountsReply.status === 200, accountsReply.status);
      const accounts = JSON.parse(accountsReply.text);
      const byId = new Map<number, Record<string, unknown>>(
        accounts.accounts.map((a: { id: number }) => [a.id, a as unknown as Record<string, unknown>]),
      );
      check("the healthy account reads connected", byId.get(ids.healthy)?.state === "connected");
      check(
        "the auth-dead account reads auth_dead, with a date and a closed reason",
        byId.get(ids.dead)?.state === "auth_dead" &&
          typeof byId.get(ids.dead)?.auth_dead_since === "string" &&
          byId.get(ids.dead)?.auth_dead_reason === "unauthorized_client",
        byId.get(ids.dead),
      );
      check("the admin-paused account reads paused", byId.get(ids.paused)?.state === "paused");
      check("the never-connected account reads disconnected", byId.get(ids.gone)?.state === "disconnected");
      check(
        "an account that is BOTH paused and auth-dead reads auth_dead, and says it is paused too",
        byId.get(ids.deadAndPaused)?.state === "auth_dead" &&
          byId.get(ids.deadAndPaused)?.paused_by_admin === true,
        byId.get(ids.deadAndPaused),
      );
      check(
        "the account whose NAME is its address gets a positional label",
        byId.get(ids.nameIsEmail)?.label === `Account ${ids.nameIsEmail}`,
        byId.get(ids.nameIsEmail)?.label,
      );
      check(
        "queue depth and last send time are real",
        byId.get(ids.dead)?.queue_depth === 2 &&
          typeof byId.get(ids.dead)?.last_send_at === "string" &&
          byId.get(ids.healthy)?.queue_depth === 1,
        { dead: byId.get(ids.dead), healthy: byId.get(ids.healthy) },
      );
      check(
        "the page reports itself honestly",
        accounts.page.total === 6 && accounts.page.returned === 6 && accounts.page.next_offset === null,
        accounts.page,
      );

      section("LIT: pagination at the 64 KB boundary");
      // 200 more accounts, every label at the maximum length, so the page the
      // Chief would actually pull is the fattest one this endpoint can produce.
      const fatLabel = "W".repeat(MAX_LABEL_CHARS);
      for (let i = 0; i < 200; i++) {
        await pool.query(
          `INSERT INTO users (email, name, is_connected, auth_dead_at, auth_dead_reason, paused_by_admin)
           VALUES ($1,$2,true,$3,'unauthorized_client',true)`,
          [`fat-${i}@smoke.invalid`, fatLabel, new Date(now.getTime() - DAY_MS)],
        );
      }
      const fatReply = await get("/api/chief/accounts?limit=200", AUTH);
      const fatBytes = Buffer.byteLength(fatReply.text, "utf8");
      check(
        `the fattest page stays under the Chief's 64 KB ceiling (${fatBytes} bytes)`,
        fatBytes <= 64 * 1024,
        fatBytes,
      );
      const fatPage = JSON.parse(fatReply.text);
      check(
        "the page never claims more rows than it carries",
        fatPage.accounts.length === fatPage.page.returned,
        { returned: fatPage.page.returned, carried: fatPage.accounts.length },
      );

      // Walk the whole set with next_offset and prove nothing is skipped or
      // repeated. This is the property the byte ceiling could otherwise break.
      const walked: number[] = [];
      let offset: number | null = 0;
      let hops = 0;
      while (offset !== null && hops < 50) {
        hops++;
        const page = JSON.parse((await get(`/api/chief/accounts?limit=37&offset=${offset}`, AUTH)).text);
        walked.push(...page.accounts.map((a: { id: number }) => a.id));
        offset = page.page.next_offset;
      }
      const total = 206;
      check(
        `next_offset walks all ${total} accounts exactly once in ${hops} pages`,
        walked.length === total && new Set(walked).size === total,
        { walked: walked.length, distinct: new Set(walked).size },
      );
    }

    // ── Spend reporting ────────────────────────────────────────────────────
    if (MODE === "dark") {
      section("DARK: the reporter is dormant and says so, once");
      check("resolveChiefConfig() is null", resolveChiefConfig() === null);

      // Asserted on the branch taken and on the exact sentence that branch
      // logs, rather than by wrapping `process.stdout.write`: pino writes to
      // fd 1 through a batching destination in production, so a captured line
      // arrives after the assertion that wanted it. The real line is visible in
      // this run's own stdout above, at `warn`.
      _resetChiefSpendReporting();
      check("boot takes the dormant branch", startChiefSpendReporting() === "dormant");
      check(
        "the sentence it logs says DORMANT and names both variables",
        CHIEF_DORMANT_MESSAGE.includes("DORMANT") &&
          CHIEF_DORMANT_MESSAGE.includes("CHIEF_URL") &&
          CHIEF_DORMANT_MESSAGE.includes("CHIEF_INGEST_TOKEN"),
        CHIEF_DORMANT_MESSAGE.slice(0, 120),
      );
      check(
        "it says it once per boot, not once per call",
        startChiefSpendReporting() === "already_started",
      );

      const cursorRows = await pool.query<{ n: string }>("select count(*)::text as n from chief_spend_cursor");
      check("a dormant reporter has written nothing to the cursor", cursorRows.rows[0].n === "0", cursorRows.rows[0].n);
      check("a dormant reporter opened no socket", vendorAttempts === 0, vendorAttempts);
    } else {
      section("LIT: the spend reporter emits correct quanta");
      const quantum = SPEND_QUANTUM_CENTS / 100;
      // $1.20 of Anthropic and $0.30 of Google, today, in UTC.
      const midday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 30));
      await seedUsage("claude-opus-4-8", 0.7, midday);
      await seedUsage("claude-haiku-4-5", 0.5, midday);
      await seedUsage("gemini-3.5-flash", 0.3, midday);

      const chief = makeFakeChief();
      const cfg = resolveChiefConfig();
      check("resolveChiefConfig() resolves in LIT mode", cfg !== null);
      const reporter = createChiefReporter(cfg!, { fetchImpl: chief.fetchImpl, retryDelaysMs: [1, 1], timeoutMs: 200 });

      const first = await runChiefSpendSweep(reporter, now);
      const dayKey = midday.toISOString().slice(0, 10);
      check(
        "$1.20 of anthropic becomes exactly two $0.50 reports; the 20c residual is NOT reported",
        chief.requests.filter((r) => r.vendor === "anthropic").length === 2,
        chief.requests,
      );
      check(
        "$0.30 of google — under one quantum — becomes no report at all",
        chief.requests.filter((r) => r.vendor === "google").length === 0,
      );
      check(
        "every report is exactly one quantum, attributed to a human",
        chief.requests.every((r) => r.amountUsd === quantum && r.initiatedBy === "human"),
        chief.requests,
      );
      check(
        "the ids name the app, the UTC day, the vendor and the running total",
        chief.requests.map((r) => r.externalId).join(",") ===
          `followup-${dayKey}-anthropic-0,followup-${dayKey}-anthropic-50`,
        chief.requests.map((r) => r.externalId),
      );
      check("the sweep reports what it did", first.recorded === 2 && first.halted === null, first);

      const cursor = await pool.query<{ vendor: string; reported_cents: number }>(
        "select vendor, reported_cents from chief_spend_cursor order by vendor",
      );
      check(
        "the cursor advanced to the confirmed dollar total, not a chunk count",
        cursor.rows.length === 1 && cursor.rows[0].vendor === "anthropic" && Number(cursor.rows[0].reported_cents) === 100,
        cursor.rows,
      );

      section("LIT: replay is idempotent");
      const secondSweep = await runChiefSpendSweep(reporter, now);
      check(
        "a second sweep with no new spend sends nothing at all",
        secondSweep.recorded === 0 && chief.requests.length === 2,
        { sweep: secondSweep, sent: chief.requests.length },
      );

      // Now the harder case: the cursor is LOST (the failure mode the schema
      // comment calls survivable). Every report goes out again — and the Chief
      // dedupes every one of them, because an amount is a pure function of its
      // id. No money is double-counted.
      await pool.query("delete from chief_spend_cursor");
      const replay = await runChiefSpendSweep(reporter, now);
      check(
        "after losing the cursor the same two ids are re-sent",
        chief.requests.length === 4 &&
          chief.requests[2].externalId === chief.requests[0].externalId &&
          chief.requests[3].externalId === chief.requests[1].externalId,
        chief.requests.map((r) => r.externalId),
      );
      check(
        "the Chief deduped both — no second row, no double charge",
        chief.rows() === 2 && replay.deduped === 2,
        { rows: chief.rows(), deduped: replay.deduped },
      );

      section("LIT: more spend resumes from the cursor");
      await seedUsage("gemini-3.5-flash", 0.25, midday);
      const third = await runChiefSpendSweep(reporter, now);
      check(
        "google crosses the quantum and reports once, from offset 0",
        third.recorded === 1 &&
          chief.requests[chief.requests.length - 1].externalId === `followup-${dayKey}-google-0`,
        chief.requests[chief.requests.length - 1],
      );
      check(
        "anthropic sends nothing new — its residual is still under a quantum",
        chief.requests.filter((r) => r.vendor === "anthropic").length === 4,
        chief.requests.filter((r) => r.vendor === "anthropic").length,
      );
    }

    // ── The leak grep, over everything ─────────────────────────────────────
    section("no email address, and no token, on any part of the HTTP surface");
    const offenders = capturedBodies.filter((b) => EMAIL_LIKE.test(b.text));
    check(
      `no captured response body contains an email address (${capturedBodies.length} bodies checked)`,
      offenders.length === 0,
      offenders.map((o) => o.what),
    );
    const tokenEchoes = capturedBodies.filter((b) => b.text.includes(TOKEN));
    check("no captured response body echoes the order-token", tokenEchoes.length === 0, tokenEchoes.map((o) => o.what));
    // Sanity: the grep can actually find an address, so a clean run means
    // something. Without this, a broken regex reads as a perfect result.
    check(
      "the leak grep is live (it finds a planted address)",
      EMAIL_LIKE.test('{"label":"dead@smoke.invalid"}'),
    );
    check("the seeded addresses really are grep-able", EMAIL_LIKE.test("nameisemail@smoke.invalid"));

    section("vendors");
    check("zero outbound vendor call attempts", vendorAttempts === 0, vendorAttempts);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }

  console.log(`\n${failures === 0 ? "SMOKE PASS" : `SMOKE FAIL — ${failures} check(s)`} (mode ${MODE})`);
}

try {
  await main();
} catch (err) {
  failures++;
  console.error("\nSMOKE ERROR:", err);
} finally {
  await pool.end();
}
process.exit(failures === 0 ? 0 : 1);
