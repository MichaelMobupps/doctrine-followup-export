/**
 * smoke-f36b.ts — F-3.6b live smoke, against an ISOLATED database.
 *
 * Exercises the real code against a real Postgres, in both modes:
 *   DARK — `GOOGLE_REFRESH_TOKEN` / `SENDER_EMAIL` / `SENDER_NAME` absent.
 *   LIT  — all three PRESENT, which is the production condition and the only
 *          one in which the deleted landmine could ever fire.
 *
 * The two modes must produce identical results. That is the claim: after
 * F-3.6b the refusal is structural, not environmental. Before F-3.6b, LIT is
 * exactly the configuration in which an ownerless prospect was delivered from
 * the shared fallback mailbox.
 *
 * ── VENDORS ARE MADE IMPOSSIBLE, NOT MERELY UNLIKELY ──────────────────────
 *
 * F-3.6a's smoke made a real Gmail call while claiming it made none, and its
 * fix was to unset three environment variables. That is a fix that depends on
 * the operator remembering, and it cannot be used at all here — LIT mode
 * needs those variables SET.
 *
 * So this smoke blocks the transport instead: `http.request`, `https.request`,
 * `http.get`, `https.get` and `globalThis.fetch` are replaced with throwers
 * BEFORE any application module is loaded. Postgres speaks over `net`/`tls`
 * and is unaffected. Any outbound call — Gmail, Anthropic, Gemini — becomes a
 * loud, attributable exception instead of a request.
 *
 * The lockout is installed before a single application import: every
 * application module is loaded through `await import()` below the guard, so
 * the ordering is guaranteed by the language rather than by ESM hoisting
 * happening to be harmless.
 *
 * ── USAGE — never point this at dev or production ─────────────────────────
 *
 *   # one isolated database per mode, each a copy of the dev SCHEMA with
 *   # cron_heartbeats deliberately removed, so the migration is exercised
 *   createdb f36b_smoke_dark
 *   pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" | psql -q f36b_smoke_dark
 *   psql -q f36b_smoke_dark -c 'DROP TABLE IF EXISTS cron_heartbeats'
 *
 *   SMOKE_MODE=dark DATABASE_URL=postgresql://…/f36b_smoke_dark \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/smoke-f36b.ts
 *
 *   # then the same for f36b_smoke_lit with SMOKE_MODE=lit, and dropdb both
 *
 * It refuses to run against a database whose name does not contain "smoke"
 * or "test".
 */

import { createRequire } from "node:module";

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
const originalFetch = globalThis.fetch;
globalThis.fetch = (() => blockOutbound("fetch")) as never;

// ── 2. Mode. Set BEFORE any application module exists. ────────────────────
const MODE = (process.env.SMOKE_MODE || "dark").toLowerCase();
if (MODE !== "dark" && MODE !== "lit") {
  console.error(`SMOKE_MODE must be "dark" or "lit" (got ${JSON.stringify(process.env.SMOKE_MODE)})`);
  process.exit(2);
}
const FALLBACK_VARS = ["GOOGLE_REFRESH_TOKEN", "SENDER_EMAIL", "SENDER_NAME"] as const;
if (MODE === "dark") {
  for (const v of FALLBACK_VARS) delete process.env[v];
} else {
  // Values that are obviously fake AND would be catastrophic if they were
  // ever used: if any of them reaches an assertion below, the fallback is
  // back. They cannot reach Google — the transport is already blocked.
  process.env.GOOGLE_REFRESH_TOKEN = "SMOKE-FAKE-REFRESH-TOKEN-MUST-NEVER-BE-USED";
  process.env.SENDER_EMAIL = "smoke-fallback@example.invalid";
  process.env.SENDER_NAME = "Smoke Fallback Identity";
}

// ── 3. Now the application. ───────────────────────────────────────────────
const { db, pool, usersTable, prospectsTable, followupsTable, cronHeartbeatsTable } =
  await import("@workspace/db");
const { eq, and, sql } = await import("drizzle-orm");
const { runStartupMigrations } = await import("../lib/startupMigrations");
const { autoQueueAllCampaigns, processDueFollowups, queueStageForProspect } =
  await import("../services/scheduler");
const { syncEmails, NoConnectedAccountsError } = await import("../services/gmailSync");
const { OWNER_MISSING_MESSAGE } = await import("../lib/ownerIdentity");

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

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function main(): Promise<void> {
  const dbName = (await pool.query<{ current_database: string }>("select current_database()")).rows[0]
    .current_database;
  if (!/smoke|test/i.test(dbName)) {
    throw new Error(`Refusing to smoke against database "${dbName}" — the name must contain "smoke" or "test".`);
  }
  console.log(
    `F-3.6b smoke — mode ${MODE.toUpperCase()}, database "${dbName}", transport blocked.\n` +
      (MODE === "lit"
        ? "  LIT: GOOGLE_REFRESH_TOKEN / SENDER_EMAIL / SENDER_NAME are all SET.\n" +
          "  This is the production configuration, and the one in which an ownerless\n" +
          "  prospect used to be delivered from the shared mailbox.\n"
        : "  DARK: the three fallback variables are absent.\n"),
  );

  // ── Vendor lockout is armed ─────────────────────────────────────────────
  section("vendor lockout");
  let fetchThrew = false;
  try {
    await (globalThis.fetch as unknown as () => Promise<unknown>)();
  } catch {
    fetchThrew = true;
  }
  check("outbound fetch throws", fetchThrew);
  let httpsThrew = false;
  try {
    (httpsMod.request as () => unknown)();
  } catch {
    httpsThrew = true;
  }
  check("outbound https.request throws", httpsThrew);
  // The two probes above are deliberate; reset the counter so any LATER
  // increment is a genuine vendor attempt by the application.
  vendorAttempts = 0;
  check("Postgres is reachable anyway (it speaks net/tls, not http)", Boolean(dbName));

  // ── Scope 4: the migration owns cron_heartbeats ─────────────────────────
  section("scope 4 — cron_heartbeats comes from the startup migration");
  const before = await pool.query(`select to_regclass('public.cron_heartbeats') as t`);
  check(
    "the database starts WITHOUT cron_heartbeats (drizzle-kit push has not run)",
    before.rows[0].t === null,
    before.rows[0],
  );

  await runStartupMigrations();

  const cols = await pool.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
      where table_name = 'cron_heartbeats'
      order by ordinal_position`,
  );
  const shape = cols.rows.map(
    (r) => `${r.column_name}|${r.data_type}|${r.is_nullable}|${r.column_default ?? ""}`,
  );
  // Byte-for-byte the production shape, read read-only from BOTH databases on
  // 2026-08-10. Anything else means a fresh database is not the database
  // production is.
  const EXPECTED_SHAPE = [
    "id|integer|NO|nextval('cron_heartbeats_id_seq'::regclass)",
    "tick_name|text|NO|",
    "fired_at|timestamp with time zone|NO|now()",
    "outcome|text|NO|",
    "duration_ms|integer|NO|0",
    "details|jsonb|YES|",
  ];
  check("the table now exists", cols.rows.length > 0);
  check("with the exact live production column shape", JSON.stringify(shape) === JSON.stringify(EXPECTED_SHAPE), shape);

  const idx = await pool.query<{ indexdef: string }>(
    `select indexdef from pg_indexes where indexname = 'idx_cron_heartbeats_tick_fired_at'`,
  );
  check("the tick/fired_at index exists", idx.rows.length === 1);
  check(
    "and carries fired_at DESC, matching production (not the ASC the drizzle declaration implies)",
    (idx.rows[0]?.indexdef ?? "").includes("(tick_name, fired_at DESC)"),
    idx.rows[0],
  );

  await runStartupMigrations();
  const afterSecond = await pool.query<{ n: string }>(
    `select count(*)::text as n from pg_indexes where indexname = 'idx_cron_heartbeats_tick_fired_at'`,
  );
  check("re-running the migration is a no-op (still exactly one index)", afterSecond.rows[0].n === "1");

  // It is a real table, not just a shape: the heartbeat writer works against it.
  await db.insert(cronHeartbeatsTable).values({
    tickName: "sync_and_autoqueue",
    outcome: "error",
    durationMs: 5,
    details: { noConnectedAccounts: true } as never,
  });
  const hb = await db.select().from(cronHeartbeatsTable);
  check("a heartbeat can be written and read back", hb.length === 1 && hb[0].outcome === "error", hb[0]);

  // ── Fixture ─────────────────────────────────────────────────────────────
  section("fixture");
  await pool.query("TRUNCATE followups, prospects, users, cron_heartbeats RESTART IDENTITY CASCADE");

  // No refresh token anywhere: even without the transport lockout, the
  // processing loop could not reach Gmail.
  const [owner] = await db
    .insert(usersTable)
    .values({ email: "owner@example.com", name: "Owner", isConnected: true })
    .returning();

  const past = new Date(Date.now() - 2 * DAY);
  async function seedProspect(args: {
    userId: number | null;
    name: string;
    app?: string;
    cycle?: number;
  }) {
    const [p] = await db
      .insert(prospectsTable)
      .values({
        userId: args.userId ?? undefined,
        prospectName: args.name,
        company: `${args.name} Co`,
        email: `${args.name.toLowerCase()}@client.example`,
        subject: "Original outreach",
        gmailThreadId: `t-${args.name}`,
        gmailMessageId: `m-${args.name}`,
        sentAt: new Date(Date.now() - 30 * DAY),
        app: args.app ?? "doctrine",
        cycle: args.cycle ?? 1,
      } as never)
      .returning();
    return p;
  }

  const pOwnerless = await seedProspect({ userId: null, name: "Ownerless" });
  const pOwned = await seedProspect({ userId: owner.id, name: "Owned" });
  // Two renewed AntiGhosting campaigns: cycle 2, with cycle 1 run to
  // completion. One for each queueing path.
  const pRenewedDirect = await seedProspect({
    userId: owner.id,
    name: "RenewedDirect",
    app: "anti_ghosting",
    cycle: 2,
  });
  const pRenewedSweep = await seedProspect({
    userId: owner.id,
    name: "RenewedSweep",
    app: "anti_ghosting",
    cycle: 2,
  });

  for (const p of [pOwnerless, pOwned]) {
    await db.insert(followupsTable).values({ prospectId: p.id, stage: 1, status: "queued", scheduledAt: past });
  }
  for (const p of [pRenewedDirect, pRenewedSweep]) {
    for (const stage of [1, 2, 3]) {
      await db.insert(followupsTable).values({
        prospectId: p.id,
        cycle: 1,
        stage,
        status: "sent",
        scheduledAt: new Date(Date.now() - (30 - stage * 7) * DAY),
        sentAt: new Date(Date.now() - (30 - stage * 7) * DAY),
      });
    }
  }
  console.log(
    "  seeded 1 connected account, 1 OWNERLESS prospect, 1 owned prospect,\n" +
      "  2 renewed AntiGhosting campaigns (prospects.cycle = 2, cycle 1 fully sent)",
  );

  // ── Scope 1: the ownerless prospect refuses ─────────────────────────────
  section("scope 1 — an ownerless prospect coming due REFUSES");
  const r = await processDueFollowups();
  check("both due rows were processed", r.processed === 2, r);
  check("NOTHING WAS SENT", r.sent === 0 && r.drafted === 0, r);
  check("exactly one row failed — the ownerless one", r.failed === 1, r);
  check("NO VENDOR CALL WAS ATTEMPTED", vendorAttempts === 0, vendorAttempts);

  const ownerlessRow = (
    await db.select().from(followupsTable).where(eq(followupsTable.prospectId, pOwnerless.id))
  )[0];
  check("the row is FAILED, not silently skipped", ownerlessRow.status === "failed", ownerlessRow.status);
  check(
    "with failure_reason 'owner_missing'",
    ownerlessRow.failureReason === "owner_missing",
    ownerlessRow.failureReason,
  );
  check(
    "and the operator sentence recorded verbatim",
    ownerlessRow.errorMessage === OWNER_MISSING_MESSAGE,
    ownerlessRow.errorMessage,
  );
  check(
    "NOTHING WAS GENERATED — no LLM cost was spent on a row that cannot send",
    ownerlessRow.generatedBody === null && ownerlessRow.generatedSubject === null,
  );
  check("no Gmail artifact id was recorded — no send was attempted", ownerlessRow.gmailMessageId === null);
  check("the row was never claimed into 'generating'", ownerlessRow.retryCount === 0);

  if (MODE === "lit") {
    // The whole point of LIT. If the fallback were back, the row would have
    // reached the transport (and thrown SMOKE LOCKOUT, giving send_error).
    check(
      "LIT: the fallback identity was SET and was still not used",
      ownerlessRow.failureReason === "owner_missing" && vendorAttempts === 0,
      { failureReason: ownerlessRow.failureReason, vendorAttempts, senderEmail: process.env.SENDER_EMAIL },
    );
    check(
      "LIT: no trace of the fallback address anywhere on the row",
      !JSON.stringify(ownerlessRow).includes("smoke-fallback@example.invalid"),
      ownerlessRow,
    );
  }

  const ownedRow = (
    await db.select().from(followupsTable).where(eq(followupsTable.prospectId, pOwned.id))
  )[0];
  check(
    "an OWNED prospect whose account holds no grant still just waits — unchanged",
    ownedRow.status === "queued" && ownedRow.failureReason === null,
    ownedRow.status,
  );

  const queuedForOwnerless = await queueStageForProspect(pOwnerless.id, 2, new Date(), { automatic: false });
  check(
    "queueStageForProspect refuses an ownerless prospect, even for a human",
    queuedForOwnerless.queued === false && queuedForOwnerless.held === "owner_missing",
    queuedForOwnerless,
  );

  // ── Scope 3: a cycle-2 AntiGhosting stage queues ────────────────────────
  section("scope 3 — a renewed AntiGhosting campaign can queue again");
  const renewed = await queueStageForProspect(pRenewedDirect.id, 1, new Date(Date.now() + HOUR), {
    automatic: false,
  });
  check("stage 1 of cycle 2 IS queued (before F-3.6b: {queued:false}, stranded)", renewed.queued === true, renewed);

  const directRows = await db
    .select()
    .from(followupsTable)
    .where(eq(followupsTable.prospectId, pRenewedDirect.id));
  const newRow = directRows.find((f) => f.status === "queued");
  check("a NEW row was created, not a revival of the old one", directRows.length === 4, directRows.length);
  check("and it carries cycle 2", newRow?.cycle === 2, newRow?.cycle);
  check("at stage 1", newRow?.stage === 1, newRow?.stage);
  const cycle1Stage1 = directRows.find((f) => f.cycle === 1 && f.stage === 1);
  check(
    "the cycle-1 stage-1 row is untouched and still SENT",
    cycle1Stage1?.status === "sent",
    cycle1Stage1?.status,
  );

  const autoQueued = await autoQueueAllCampaigns();
  check("the auto-queue sweep queued the second renewed campaign too", autoQueued >= 1, autoQueued);
  const sweepRows = await db
    .select()
    .from(followupsTable)
    .where(and(eq(followupsTable.prospectId, pRenewedSweep.id), eq(followupsTable.cycle, 2)));
  check(
    "the sweep's row is cycle 2, stage 1 — not cycle 1, stage 4 rejected by the cap",
    sweepRows.length === 1 && sweepRows[0].stage === 1,
    sweepRows.map((f) => ({ cycle: f.cycle, stage: f.stage })),
  );

  const doctrineRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(followupsTable)
    .where(eq(followupsTable.prospectId, pOwned.id));
  check("the doctrine campaign gained nothing from cycle scoping — unchanged", doctrineRows[0].n === 1, doctrineRows[0]);

  // ── Scope 2: zero connected accounts reports the truth ──────────────────
  section("scope 2 — a sync with zero connected accounts tells the truth");
  await db.update(usersTable).set({ isConnected: false }).where(eq(usersTable.id, owner.id));

  let syncOutcome: unknown = null;
  let threw: unknown = null;
  try {
    syncOutcome = await syncEmails();
  } catch (err) {
    threw = err;
  }
  check("it does NOT return a result object", syncOutcome === null, syncOutcome);
  check("it throws NoConnectedAccountsError", threw instanceof NoConnectedAccountsError, String(threw));
  check(
    "carrying a 503 so the /sync routes surface it instead of 200-ing",
    (threw as { statusCode?: number })?.statusCode === 503,
    (threw as { statusCode?: number })?.statusCode,
  );
  check(
    "and a message that names the real condition",
    /No Gmail account is connected/i.test(String((threw as Error)?.message)),
    (threw as Error)?.message,
  );
  check("NO VENDOR CALL was attempted on the way to that answer", vendorAttempts === 0, vendorAttempts);

  if (MODE === "lit") {
    check(
      "LIT: the legacy env-var mailbox was available and was NOT used",
      threw instanceof NoConnectedAccountsError,
      String(threw),
    );
  }

  // One connected account is enough to leave that state — the error is scoped
  // to the condition, not to an empty inbox.
  await db.update(usersTable).set({ isConnected: true }).where(eq(usersTable.id, owner.id));
  let secondThrew: unknown = null;
  let secondOutcome: { synced: number; perUser: unknown[] } | null = null;
  try {
    secondOutcome = await syncEmails();
  } catch (err) {
    secondThrew = err;
  }
  check(
    "with one account connected it no longer throws",
    !(secondThrew instanceof NoConnectedAccountsError),
    String(secondThrew),
  );
  check("and returns a normal result", secondOutcome !== null, secondOutcome ?? String(secondThrew));
  check("still no vendor call", vendorAttempts === 0, vendorAttempts);

  // ── Summary ─────────────────────────────────────────────────────────────
  section("result");
  console.log(`  mode: ${MODE.toUpperCase()}   vendor call attempts: ${vendorAttempts}`);
  if (failures === 0) {
    console.log("  ALL CHECKS PASSED — no vendor call was made or attempted at any point.");
  } else {
    console.log(`  ${failures} CHECK(S) FAILED`);
  }
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("smoke crashed:", err);
  globalThis.fetch = originalFetch;
  await pool.end().catch(() => {});
  process.exit(1);
});
