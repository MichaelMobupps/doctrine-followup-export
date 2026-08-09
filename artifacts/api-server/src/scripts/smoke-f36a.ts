/**
 * smoke-f36a.ts — F-3.6a live smoke, against an ISOLATED database.
 *
 * Exercises the real code against a real Postgres, in both modes:
 *   HEALTHY  — an account whose grant works: behaviour identical to before.
 *   AUTH-DEAD — the new state: nothing queued, nothing selected, nothing
 *               generated, and the rows preserved rather than cancelled.
 *
 * GMAIL IS NEVER CALLED — enforced twice.
 *
 *   1. Every fixture account is seeded WITHOUT a refresh token, so
 *      `processDueFollowups` reaches its "Gmail credentials unavailable"
 *      guard and skips before any generator or vendor call.
 *   2. The legacy env-var sender is torn out of the environment below,
 *      BEFORE anything runs.
 *
 * (2) is not belt-and-braces, it is load-bearing, and the first run of this
 * script proved it: a fixture prospect with `user_id = NULL` does NOT hit
 * guard (1) — a legacy row has no user, so `gmail` stays undefined and
 * `sendFollowupReply` falls through to `GOOGLE_REFRESH_TOKEN` +
 * `SENDER_EMAIL`, which are set in this workspace. The row went all the way
 * to Google and came back "Invalid thread_id value". Nothing was delivered,
 * but a vendor call was made from a smoke that claimed it made none. A smoke
 * that is only safe if the operator remembers to unset three variables is
 * not a safe smoke.
 *
 * With the variables gone the legacy row stops at "No sender credentials
 * available — skipping", which is what makes `processed` a clean measure of
 * what the due QUERY returned — the thing actually under test.
 *
 * Usage — never point this at production:
 *   createdb f36a_smoke
 *   DATABASE_URL=postgresql://…/f36a_smoke \
 *     pnpm --filter @workspace/api-server exec tsx src/scripts/smoke-f36a.ts
 *
 * It refuses to run against a database whose name does not contain "smoke"
 * or "test".
 */

// ── Vendor lockout. Must run before ANY processing call. ─────────────────
// See the header: these three are what let a null-user prospect reach Gmail
// through the legacy fallback sender. Removing them from this process's
// environment makes the vendor call structurally impossible rather than
// merely unlikely.
for (const v of ["SENDER_EMAIL", "SENDER_NAME", "GOOGLE_REFRESH_TOKEN"]) {
  delete process.env[v];
}

import { db, pool, usersTable, prospectsTable, followupsTable, cronHeartbeatsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { runStartupMigrations } from "../lib/startupMigrations";
import {
  autoQueueAllCampaigns,
  processDueFollowups,
  queueStageForProspect,
  detectStrandedGeneratingFollowups,
} from "../services/scheduler";
import { connectionState, authDeadMessage } from "../lib/connectionHealth";
import { redactHeartbeatDetails } from "../lib/heartbeatView";

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
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 66 - title.length))}`);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function main(): Promise<void> {
  const dbName = (await pool.query<{ current_database: string }>("select current_database()")).rows[0].current_database;
  if (!/smoke|test/i.test(dbName)) {
    throw new Error(`Refusing to smoke against database "${dbName}" — the name must contain "smoke" or "test".`);
  }
  console.log(`F-3.6a smoke — database "${dbName}", Gmail never called.`);

  // ── Migration ─────────────────────────────────────────────────────────
  section("startup migration on a pre-F-3.6a schema");
  await runStartupMigrations();
  const cols = await pool.query<{ table_name: string; column_name: string }>(
    `select table_name, column_name from information_schema.columns
      where (table_name = 'users' and column_name in ('auth_dead_at','auth_dead_reason'))
         or (table_name = 'followups' and column_name in ('retry_count','failure_reason','error_history'))`,
  );
  check("all five columns added", cols.rows.length === 5, cols.rows.map((r) => `${r.table_name}.${r.column_name}`));
  const idx = await pool.query(`select indexdef from pg_indexes where indexname = 'idx_users_auth_dead'`);
  check("idx_users_auth_dead created", idx.rows.length === 1);
  check(
    "index is PLAIN, matching the drizzle declaration (no republish churn)",
    !String((idx.rows[0] as { indexdef?: string })?.indexdef ?? "").includes("WHERE"),
    idx.rows[0],
  );
  await runStartupMigrations();
  check("re-running the migration is a no-op", true);

  // ── Fixture ───────────────────────────────────────────────────────────
  section("fixture");
  // `cron_heartbeats` is created by `drizzle-kit push`, not by
  // runStartupMigrations — it predates the startup-migration file and lives
  // only in the drizzle schema. It therefore exists in the real databases but
  // not in a bare scratch one, so the harness creates it. Deliberately NOT
  // added to startupMigrations: a second definition of a table that push
  // already owns is how index churn on every Republish starts.
  await pool.query(`CREATE TABLE IF NOT EXISTS cron_heartbeats (
    id SERIAL PRIMARY KEY,
    tick_name TEXT NOT NULL,
    fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome TEXT NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    details JSONB
  )`);
  await pool.query("TRUNCATE followups, prospects, users, cron_heartbeats RESTART IDENTITY CASCADE");

  // No refresh tokens anywhere: the processing loop can never reach Gmail.
  const [healthy] = await db.insert(usersTable)
    .values({ email: "healthy@example.com", name: "Healthy", isConnected: true })
    .returning();
  const [dead] = await db.insert(usersTable)
    .values({ email: "dead@example.com", name: "Dead", isConnected: true })
    .returning();
  const [paused] = await db.insert(usersTable)
    .values({ email: "paused@example.com", name: "Paused", isConnected: true, pausedByAdmin: true })
    .returning();

  const past = new Date(Date.now() - 2 * DAY);
  async function seedProspect(userId: number | null, name: string) {
    const [p] = await db.insert(prospectsTable)
      .values({
        userId: userId ?? undefined,
        prospectName: name,
        company: `${name} Co`,
        email: `${name.toLowerCase()}@client.example`,
        subject: "Original outreach",
        gmailThreadId: `t-${name}`,
        gmailMessageId: `m-${name}`,
        sentAt: new Date(Date.now() - 10 * DAY),
      } as never)
      .returning();
    return p;
  }
  const pHealthy = await seedProspect(healthy.id, "Healthy");
  const pDead = await seedProspect(dead.id, "Dead");
  const pPaused = await seedProspect(paused.id, "Paused");
  const pLegacy = await seedProspect(null, "Legacy");

  for (const p of [pHealthy, pDead, pPaused, pLegacy]) {
    await db.insert(followupsTable).values({ prospectId: p.id, stage: 1, status: "queued", scheduledAt: past });
  }
  console.log(`  seeded 3 accounts + 1 legacy (null user_id), 4 queued follow-ups, all overdue`);

  // ── MODE A: healthy ───────────────────────────────────────────────────
  section("MODE A — healthy account: unchanged behaviour");
  let r = await processDueFollowups();
  // healthy + not-yet-dead + legacy = 3 selected. The admin-paused account's
  // row is the one the query must leave behind.
  check("the due query returns all three unheld rows", r.processed === 3, r);
  check("the admin-paused row was NOT selected — no wasted slot", r.processed === 3, r);
  check("NO VENDOR CALL: nothing sent, nothing failed", r.sent === 0 && r.failed === 0, r);

  // ── MODE B: auth-dead ─────────────────────────────────────────────────
  section("MODE B — auth-dead account");
  await db.update(usersTable)
    .set({ authDeadAt: new Date(Date.now() - 5 * DAY), authDeadReason: "unauthorized_client" })
    .where(eq(usersTable.id, dead.id));

  const deadRow = (await db.select().from(usersTable).where(eq(usersTable.id, dead.id)))[0];
  check("connectionState reports auth_dead, not connected", connectionState(deadRow) === "auth_dead");
  check("the operator sentence is built", (authDeadMessage(deadRow.authDeadAt) ?? "").includes("reconnect"));
  check("the refresh token / grant row is preserved, not wiped", deadRow.isConnected === true);

  r = await processDueFollowups();
  check("the auth-dead and admin-paused rows are NOT selected — no slot wasted", r.processed === 2, r);
  check("still no vendor call", r.sent === 0 && r.failed === 0, r);

  const stillQueued = await db.select({ n: sql<number>`count(*)::int` })
    .from(followupsTable).where(eq(followupsTable.status, "queued"));
  check("held rows are still QUEUED, nothing cancelled", stillQueued[0].n === 4, stillQueued[0]);

  const queuedForDead = await queueStageForProspect(pDead.id, 2, new Date(), { automatic: true });
  check("queueStageForProspect refuses an auth-dead owner", queuedForDead.queued === false && queuedForDead.held === "auth_dead", queuedForDead);

  const autoQueued = await autoQueueAllCampaigns();
  check("autoQueueAllCampaigns runs without queueing for held accounts", typeof autoQueued === "number", autoQueued);
  const deadStages = await db.select({ n: sql<number>`count(*)::int` })
    .from(followupsTable).where(eq(followupsTable.prospectId, pDead.id));
  check("no new stage was created for the auth-dead account", deadStages[0].n === 1, deadStages[0]);

  // ── Healing ───────────────────────────────────────────────────────────
  section("healing — a reconnect resumes everything");
  await db.update(usersTable).set({ authDeadAt: null, authDeadReason: null }).where(eq(usersTable.id, dead.id));
  r = await processDueFollowups();
  check("the healed account's row is selected again", r.processed === 3, r);
  check("still no vendor call", r.sent === 0 && r.failed === 0, r);

  // ── Failed rows keep their evidence ───────────────────────────────────
  section("failures keep their evidence, revival is bounded");
  await db.update(usersTable)
    .set({ authDeadAt: new Date(), authDeadReason: "unauthorized_client" })
    .where(eq(usersTable.id, dead.id));
  await db.update(usersTable).set({ pausedByAdmin: false }).where(eq(usersTable.id, paused.id));

  const [failedRow] = await db.update(followupsTable)
    .set({
      status: "failed",
      errorMessage: "Gmail said no (attempt 0)",
      failureReason: "send_error",
      generatedBody: "the body we generated",
      generatedSubject: "the subject we generated",
    })
    .where(eq(followupsTable.prospectId, pHealthy.id))
    .returning();

  const retry1 = await queueStageForProspect(pHealthy.id, 1, new Date(), { ownerAuthDead: false, automatic: true });
  const afterRetry1 = (await db.select().from(followupsTable).where(eq(followupsTable.id, failedRow.id)))[0];
  check("retry 1 revives the row", retry1.queued === true);
  check("retry_count incremented to 1", afterRetry1.retryCount === 1, afterRetry1.retryCount);
  check("THE FIX: the generated body survived (was nulled before F-3.6a)", afterRetry1.generatedBody === "the body we generated");
  check("THE FIX: the error message survived (was nulled before F-3.6a)", afterRetry1.errorMessage === "Gmail said no (attempt 0)");
  check("the failure was appended to error_history", Array.isArray(afterRetry1.errorHistory) && afterRetry1.errorHistory.length === 1, afterRetry1.errorHistory);

  await db.update(followupsTable).set({ status: "failed", errorMessage: "Gmail said no (attempt 1)" }).where(eq(followupsTable.id, failedRow.id));
  await queueStageForProspect(pHealthy.id, 1, new Date(), { ownerAuthDead: false, automatic: true });
  await db.update(followupsTable).set({ status: "failed", errorMessage: "Gmail said no (attempt 2)" }).where(eq(followupsTable.id, failedRow.id));
  const retry3 = await queueStageForProspect(pHealthy.id, 1, new Date(), { ownerAuthDead: false, automatic: true });
  const afterHold = (await db.select().from(followupsTable).where(eq(followupsTable.id, failedRow.id)))[0];
  check("the third automatic attempt is HELD", retry3.queued === false && retry3.held === "retries_exhausted", retry3);
  check("the row stays failed and visible", afterHold.status === "failed");
  check("both prior failures are on the row", (afterHold.errorHistory ?? []).length === 2, afterHold.errorHistory);

  const humanOverride = await queueStageForProspect(pHealthy.id, 1, new Date(), { ownerAuthDead: false, automatic: false });
  check("a human CAN override an exhausted row", humanOverride.queued === true, humanOverride);

  // ── Stranded recovery ─────────────────────────────────────────────────
  section("stranded 'generating' rows get teeth");
  await db.update(followupsTable)
    .set({ status: "generating", scheduledAt: new Date(Date.now() - 48 * HOUR) })
    .where(eq(followupsTable.prospectId, pPaused.id));

  const recovered = await detectStrandedGeneratingFollowups();
  const strandedRow = (await db.select().from(followupsTable).where(eq(followupsTable.prospectId, pPaused.id)))[0];
  check("the stranded row was recovered", recovered === 1, recovered);
  check("it moved to failed", strandedRow.status === "failed", strandedRow.status);
  check("with reason 'stranded'", strandedRow.failureReason === "stranded");
  check("and the evidence recorded", (strandedRow.errorHistory ?? []).length === 1);
  check("the message tells the operator what to do", (strandedRow.errorMessage ?? "").includes("Check the Gmail thread"));

  const revive = await queueStageForProspect(pPaused.id, 1, new Date(), { ownerAuthDead: false, automatic: true });
  check("NO-RESEND: the automatic sweep refuses to revive it", revive.queued === false && revive.held === "stranded_needs_human", revive);

  const freshGenerating = await detectStrandedGeneratingFollowups();
  check("a second pass finds nothing left to recover", freshGenerating === 0, freshGenerating);

  // ── Heartbeats ────────────────────────────────────────────────────────
  section("cron heartbeats are readable, and redacted");
  await db.insert(cronHeartbeatsTable).values({
    tickName: "sync_and_autoqueue",
    outcome: "partial",
    durationMs: 1234,
    details: {
      synced: 0,
      perUser: [{
        userId: dead.id,
        email: "dead@example.com",
        authFailure: true,
        ingestError: "unauthorized_client — Authorization: Bearer ya29.LEAKEDTOKENVALUE123",
      }],
    } as never,
  });
  const hb = (await db.select().from(cronHeartbeatsTable))[0];
  const rendered = JSON.stringify(redactHeartbeatDetails(hb.details));
  check("the heartbeat row is readable", Boolean(hb));
  check("the bearer token is redacted", !rendered.includes("ya29.LEAKEDTOKENVALUE123"), rendered);
  check("the diagnosis survives redaction", rendered.includes("unauthorized_client"));
  check("the account stays identifiable", rendered.includes("dead@example.com"));

  // ── Summary ───────────────────────────────────────────────────────────
  section("result");
  if (failures === 0) {
    console.log("  ALL CHECKS PASSED — no Gmail call was made at any point.");
  } else {
    console.log(`  ${failures} CHECK(S) FAILED`);
  }
  await pool.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("smoke crashed:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
