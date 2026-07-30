/**
 * Company-Reply Cascade — deterministic QA harness.
 *
 * Proves the cascade logic against the real database, with no Gmail, no model
 * call, and no admin API key. It seeds a small set of synthetic prospects at an
 * isolated fake company domain, runs the real cascade engine, asserts which
 * rows paused and which did not, verifies idempotency and undo, then deletes
 * every row it created.
 *
 * It connects through the app's own DATABASE_URL, so it runs against whatever
 * database the shell points at. In the normal workspace shell that is the
 * development database. It cleans up after itself regardless of outcome.
 *
 * Run:
 *   pnpm --filter @workspace/api-server exec tsx src/scripts/cascade-qa.ts
 *
 * Exit code 0 means every assertion passed. Non-zero means a failure (printed).
 */

import { db, pool, prospectsTable, appSettingsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import {
  cascadeCompanyPauseOnPositiveReply,
  undoCascadeForTrigger,
  getCompanyCascadeState,
  setCompanyCascadeEnabled,
  COMPANY_CASCADE_ENABLED_KEY,
} from "../services/companyCascade";

const STAMP = Date.now();
const DOMAIN = `qa-cascade-${STAMP}.example`; // reserved TLD; never a real prospect
const SUBHOST = `sub.${DOMAIN}`;
const BATCH = `__QA_CASCADE_${STAMP}__`;

const now = new Date();
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? "  ::  " + detail : ""}`);
  }
}

let seq = 0;
async function seed(opts: {
  email: string;
  thread: string;
  sentAt: Date;
  app?: "doctrine" | "context" | "anti_ghosting";
  followupPaused?: boolean;
  pauseReason?: "manual_intervention";
  replied?: number;
}): Promise<number> {
  seq++;
  const [row] = await db
    .insert(prospectsTable)
    .values({
      userId: null, // legacy single-tenant path
      gmailMessageId: `${BATCH}-msg-${seq}`,
      gmailThreadId: opts.thread,
      email: opts.email,
      company: DOMAIN,
      batchLabel: BATCH,
      sentAt: opts.sentAt,
      app: opts.app ?? "doctrine",
      replied: opts.replied ?? 0,
      followupPaused: opts.followupPaused ?? false,
      pauseReason: opts.pauseReason ?? null,
    })
    .returning({ id: prospectsTable.id });
  return row.id;
}

async function getRow(id: number) {
  const [row] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id));
  return row;
}

async function cleanup() {
  // Null any within-batch self-references first so the FK does not block
  // delete. Wrapped so a degenerate failure (e.g. column absent) still lets
  // the delete run.
  try {
    await db.execute(sql`UPDATE prospects SET cascade_paused_by_prospect_id = NULL WHERE batch_label = ${BATCH}`);
  } catch {
    /* column may not exist in a degenerate failure path; delete still works */
  }
  const del = await db.delete(prospectsTable).where(eq(prospectsTable.batchLabel, BATCH));
  console.log(`\nCleanup: removed ${del.rowCount ?? 0} synthetic rows (batch ${BATCH}).`);
}

async function ensureSchema() {
  // Apply the exact idempotent column-adds the API server runs at boot
  // (startupMigrations). Lets the harness run whether or not the dev app has
  // rebooted since the ship. Safe to run repeatedly.
  await db.execute(sql`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS reply_class TEXT`);
  await db.execute(sql`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS cascade_paused_by_prospect_id INTEGER`);
  await db.execute(sql`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_prospects_cascade_trigger') THEN
        ALTER TABLE prospects ADD CONSTRAINT fk_prospects_cascade_trigger
          FOREIGN KEY (cascade_paused_by_prospect_id) REFERENCES prospects(id);
      END IF;
    END $$`);
  await db.execute(sql`ALTER TABLE prospects ADD COLUMN IF NOT EXISTS reply_classified_msg_id TEXT`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_prospects_cascade_trigger
    ON prospects(cascade_paused_by_prospect_id) WHERE cascade_paused_by_prospect_id IS NOT NULL`);
}

async function precleanOrphans() {
  // Remove leftover synthetic rows from any earlier interrupted run.
  // starts_with avoids LIKE wildcard pitfalls with the underscore-heavy prefix.
  await db.execute(sql`UPDATE prospects SET cascade_paused_by_prospect_id = NULL WHERE starts_with(batch_label, '__QA_CASCADE_')`);
  const res: any = await db.execute(sql`DELETE FROM prospects WHERE starts_with(batch_label, '__QA_CASCADE_')`);
  const n = res?.rowCount ?? 0;
  if (n > 0) console.log(`Pre-clean: removed ${n} leftover synthetic row(s) from prior runs.`);
}

async function main() {
  console.log(`Company-Reply Cascade QA  (domain ${DOMAIN})\n`);

  // Record the switch state so we can leave it exactly as we found it.
  const priorState = await getCompanyCascadeState();
  const switchRowExisted = priorState.updatedAt !== null;

  // Make the harness self-sufficient: apply the idempotent boot migrations,
  // then clear any orphans from an earlier interrupted run.
  await ensureSchema();
  await precleanOrphans();
  await setCompanyCascadeEnabled(true);

  try {
    // ── Seed ───────────────────────────────────────────────────────────
    const triggerId = await seed({
      email: `replier@${DOMAIN}`,
      thread: "qa-thread-trigger",
      sentAt: now,
      app: "doctrine",
      replied: 1,
      followupPaused: true,
    });
    const idA = await seed({ email: `sibA@${DOMAIN}`, thread: "qa-thread-A", sentAt: daysAgo(2), app: "doctrine" });
    const idB = await seed({ email: `sibB@${DOMAIN}`, thread: "qa-thread-B", sentAt: daysAgo(13), app: "context" });
    const idC = await seed({ email: `sibC@${DOMAIN}`, thread: "qa-thread-C", sentAt: daysAgo(30), app: "doctrine" }); // out of window
    const idD = await seed({ email: `sibD@${SUBHOST}`, thread: "qa-thread-D", sentAt: daysAgo(1), app: "doctrine" }); // different host
    const idE = await seed({ email: `sibE@${DOMAIN}`, thread: "qa-thread-E", sentAt: daysAgo(1), app: "doctrine", followupPaused: true, pauseReason: "manual_intervention" }); // already paused
    const idF = await seed({ email: `sibF@${DOMAIN}`, thread: "qa-thread-F", sentAt: daysAgo(1), app: "anti_ghosting" }); // ineligible product

    // ── Run the cascade ────────────────────────────────────────────────
    const result = await cascadeCompanyPauseOnPositiveReply({
      userId: null,
      replierEmail: `replier@${DOMAIN}`,
      replierSentAt: now,
      replierThreadId: "qa-thread-trigger",
      triggerProspectId: triggerId,
    });

    const pausedSet = new Set(result.pausedProspectIds);
    check("engine returns enabled, no skip", result.enabled === true && !result.skipped, JSON.stringify(result));
    check("exactly 2 siblings paused", result.candidateCount === 2, `candidateCount=${result.candidateCount}`);
    check("paused set is {A,B}", pausedSet.size === 2 && pausedSet.has(idA) && pausedSet.has(idB), `[${result.pausedProspectIds}] expected [${idA},${idB}]`);

    const [a, b, c, d, e, f] = await Promise.all([getRow(idA), getRow(idB), getRow(idC), getRow(idD), getRow(idE), getRow(idF)]);

    check("A paused with cascade reason + trigger link", a.followupPaused === true && a.pauseReason === "company_reply_cascade" && a.cascadePausedByProspectId === triggerId, `A=${a.pauseReason}/${a.cascadePausedByProspectId}`);
    check("B (context, window edge) paused with cascade reason", b.followupPaused === true && b.pauseReason === "company_reply_cascade" && b.cascadePausedByProspectId === triggerId, `B=${b.pauseReason}`);
    check("C out-of-window NOT paused", c.followupPaused === false && c.pauseReason === null, `C=${c.followupPaused}/${c.pauseReason}`);
    check("D different-host NOT paused", d.followupPaused === false && d.pauseReason === null, `D=${d.followupPaused}/${d.pauseReason}`);
    check("E already-paused untouched (reason preserved)", e.followupPaused === true && e.pauseReason === "manual_intervention" && e.cascadePausedByProspectId === null, `E=${e.pauseReason}/${e.cascadePausedByProspectId}`);
    check("F ineligible-app NOT paused", f.followupPaused === false && f.pauseReason === null, `F=${f.followupPaused}/${f.pauseReason}`);

    // ── Idempotency: a second run pauses nothing more ──────────────────
    const second = await cascadeCompanyPauseOnPositiveReply({
      userId: null,
      replierEmail: `replier@${DOMAIN}`,
      replierSentAt: now,
      replierThreadId: "qa-thread-trigger",
      triggerProspectId: triggerId,
    });
    check("second run is a no-op (0 paused)", second.candidateCount === 0, `candidateCount=${second.candidateCount}`);

    // ── Free-webmail replier short-circuits before any pause ───────────
    const freeResult = await cascadeCompanyPauseOnPositiveReply({
      userId: null,
      replierEmail: "someone@gmail.com",
      replierSentAt: now,
      replierThreadId: "qa-thread-free",
      triggerProspectId: triggerId,
    });
    check("free-webmail replier skipped (no_company_domain)", freeResult.skipped === "no_company_domain" && freeResult.candidateCount === 0, JSON.stringify(freeResult));

    // ── Undo restores exactly the cascade-paused set ───────────────────
    const restored = await undoCascadeForTrigger(triggerId);
    check("undo restores 2 siblings", restored === 2, `restored=${restored}`);

    const [a2, b2, e2] = await Promise.all([getRow(idA), getRow(idB), getRow(idE)]);
    check("A restored (active, reason + link cleared)", a2.followupPaused === false && a2.pauseReason === null && a2.cascadePausedByProspectId === null, `A=${a2.followupPaused}/${a2.pauseReason}`);
    check("B restored (active, reason + link cleared)", b2.followupPaused === false && b2.pauseReason === null && b2.cascadePausedByProspectId === null, `B=${b2.followupPaused}/${b2.pauseReason}`);
    check("E (manual pause) NOT touched by undo", e2.followupPaused === true && e2.pauseReason === "manual_intervention", `E=${e2.followupPaused}/${e2.pauseReason}`);
  } finally {
    await cleanup();
    // Leave the switch exactly as we found it.
    if (switchRowExisted) {
      await setCompanyCascadeEnabled(priorState.enabled);
    } else {
      await db.delete(appSettingsTable).where(eq(appSettingsTable.key, COMPANY_CASCADE_ENABLED_KEY));
    }
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES PRESENT"}  —  ${pass} passed, ${fail} failed.`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\nHARNESS ERROR:", err);
  try {
    await cleanup();
  } catch (cleanupErr) {
    console.error("Cleanup after error also failed:", cleanupErr);
    console.error(`Manually remove rows where batch_label = '${BATCH}' if any remain.`);
  }
  try {
    await pool.end();
  } catch {}
  process.exit(2);
});
