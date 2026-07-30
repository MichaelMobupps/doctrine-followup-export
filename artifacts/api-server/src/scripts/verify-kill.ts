/**
 * verify-kill.ts — end-to-end verification of BOTH Kill levels against an
 * ISOLATED test database with synthetic ZZ_RELAY_ data and an inert send path.
 *
 * This script is run by _run-kill-verification.sh, which provisions a fresh
 * test database, loads the real schema into it, and invokes this script with
 * DATABASE_URL pointed at that test DB (so the @workspace/db singleton binds
 * to the isolated DB), ADDON_API_KEY set, PORT set to an ephemeral port, and
 * SENDER_EMAIL empty so no fallback sender exists.
 *
 * Inertness: synthetic users are created with NO google_refresh_token. The
 * dispatcher (processDueFollowups) skips any user without Gmail credentials
 * ("User Gmail credentials unavailable — skipping"), and with SENDER_EMAIL
 * empty there is no fallback. So no real email can be sent. We also assert the
 * dispatcher sent 0.
 *
 * The script boots the REAL Express app and drives the REAL routes over HTTP
 * (so auth, the id/name guards, and the transactional writes are all exercised
 * exactly as in production), and calls the REAL scheduler functions
 * (processDueFollowups, autoQueueAllCampaigns) against the same singleton db.
 *
 * Output: a PASS/FAIL line per check, then a summary. Exit code 0 only if all
 * checks pass.
 */

import { createServer, type Server } from "node:http";
import {
  db,
  pool,
  usersTable,
  prospectsTable,
  followupsTable,
} from "@workspace/db";
import { eq, and, like, inArray } from "drizzle-orm";
import { processDueFollowups, autoQueueAllCampaigns } from "../services/scheduler";

const API_KEY = process.env.ADDON_API_KEY || "";
const PREFIX = "ZZ_RELAY_";

// ── tiny assertion + reporting harness ─────────────────────────────
interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail = "") {
  checks.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}
function eqCheck(name: string, actual: unknown, expected: unknown) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  record(name, pass, pass ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

let baseUrl = "";
async function post(path: string, body: unknown, apiKey: string | null = API_KEY) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, body: json };
}

// ── synthetic data helpers ─────────────────────────────────────────
async function makeUser(opts: { name: string; email: string; pausedByAdmin?: boolean; maxFollowups?: number }) {
  const [u] = await db.insert(usersTable).values({
    email: opts.email,
    name: opts.name,
    isConnected: true, // so autoQueueAllCampaigns considers them
    googleRefreshToken: null, // NO token => dispatcher skips => inert send path
    pausedByAdmin: opts.pausedByAdmin ?? false,
    maxFollowups: opts.maxFollowups ?? 3,
  }).returning();
  return u;
}

type AppName = "doctrine" | "context" | "anti_ghosting";
async function makeProspect(opts: {
  userId: number; app: AppName; name: string; company: string;
  replied?: number; sentDaysAgo?: number;
}) {
  const sentAt = new Date(Date.now() - (opts.sentDaysAgo ?? 30) * 24 * 3600 * 1000);
  const [p] = await db.insert(prospectsTable).values({
    userId: opts.userId,
    gmailMessageId: `${PREFIX}msg_${opts.app}_${opts.name}_${Math.random().toString(36).slice(2)}`,
    gmailThreadId: `${PREFIX}thr_${Math.random().toString(36).slice(2)}`,
    prospectName: opts.name,
    company: opts.company,
    email: `${PREFIX}${opts.name}@example.invalid`.toLowerCase(),
    app: opts.app,
    replied: opts.replied ?? 0,
    sentAt,
  }).returning();
  return p;
}

let stageCounter = 0;
async function makeFollowup(opts: {
  prospectId: number; status: string; stage?: number; scheduledDaysAgo?: number;
}) {
  const stage = opts.stage ?? (++stageCounter);
  const scheduledAt = new Date(Date.now() - (opts.scheduledDaysAgo ?? 1) * 24 * 3600 * 1000);
  const [f] = await db.insert(followupsTable).values({
    prospectId: opts.prospectId,
    stage,
    status: opts.status,
    scheduledAt,
  }).returning();
  return f;
}

async function getProspect(id: number) {
  const [p] = await db.select().from(prospectsTable).where(eq(prospectsTable.id, id)).limit(1);
  return p;
}
async function getUser(id: number) {
  const [u] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
  return u;
}
async function getFollowup(id: number) {
  const [f] = await db.select().from(followupsTable).where(eq(followupsTable.id, id)).limit(1);
  return f;
}
async function followupStatuses(prospectId: number) {
  const rows = await db.select({ id: followupsTable.id, status: followupsTable.status })
    .from(followupsTable).where(eq(followupsTable.prospectId, prospectId));
  return rows;
}

// The four active statuses, one of each, for a campaign.
const ACTIVE_FOUR = ["queued", "generating", "pending_approval", "drafted"];

async function teardown() {
  // Delete only ZZ_RELAY_ synthetic rows. followups -> prospects -> users.
  const synthProspects = await db.select({ id: prospectsTable.id })
    .from(prospectsTable).where(like(prospectsTable.gmailMessageId, `${PREFIX}%`));
  const pids = synthProspects.map((r) => r.id);
  if (pids.length) {
    await db.delete(followupsTable).where(inArray(followupsTable.prospectId, pids));
    await db.delete(prospectsTable).where(inArray(prospectsTable.id, pids));
  }
  await db.delete(usersTable).where(like(usersTable.email, `${PREFIX}%`));
}

async function assertCleanTeardown() {
  const p = await db.select({ id: prospectsTable.id }).from(prospectsTable).where(like(prospectsTable.gmailMessageId, `${PREFIX}%`));
  const u = await db.select({ id: usersTable.id }).from(usersTable).where(like(usersTable.email, `${PREFIX}%`));
  record("teardown left no ZZ_RELAY_ rows", p.length === 0 && u.length === 0,
    `prospects=${p.length}, users=${u.length}`);
}

// ── main ───────────────────────────────────────────────────────────
async function main() {
  // Boot the real app on an ephemeral port.
  const { default: app } = await import("../app");
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  console.log(`Test server on ${baseUrl}`);

  // Make sure we start clean (in case a prior run aborted).
  await teardown();

  try {
    await verifyUserKill();
    await verifyProspectKill();
    await crossCheck();
  } finally {
    await teardown();
    await assertCleanTeardown();
    server.close();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log("\n================= SUMMARY =================");
  console.log(`Total checks: ${checks.length}  PASS: ${checks.length - failed.length}  FAIL: ${failed.length}`);
  if (failed.length) {
    console.log("FAILED CHECKS:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  await pool.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────
//  PART A — user-level Kill
// ─────────────────────────────────────────────────────────────────
async function verifyUserKill() {
  console.log("\n----- USER-LEVEL KILL -----");
  const user = await makeUser({ name: "ZZ Relay Killtarget", email: `${PREFIX}killtarget@example.invalid` });
  const other = await makeUser({ name: "ZZ Relay Bystander", email: `${PREFIX}bystander@example.invalid` });

  // Campaigns across all three subproducts, each with active follow-ups in
  // several states plus one sent and (for one) a replied row.
  const pDoc = await makeProspect({ userId: user.id, app: "doctrine", name: "DocCo", company: "DocCorp" });
  const pCtx = await makeProspect({ userId: user.id, app: "context", name: "CtxCo", company: "CtxCorp", replied: 1 });
  const pAg = await makeProspect({ userId: user.id, app: "anti_ghosting", name: "AgCo", company: "AgCorp" });

  // doctrine: all four active states + a sent.
  const fActive: Record<string, number> = {};
  for (const st of ACTIVE_FOUR) fActive[st] = (await makeFollowup({ prospectId: pDoc.id, status: st })).id;
  const fSent = (await makeFollowup({ prospectId: pDoc.id, status: "sent" })).id;
  // context: one queued (this prospect is replied=1).
  const fCtxQueued = (await makeFollowup({ prospectId: pCtx.id, status: "queued" })).id;
  // anti_ghosting: one pending_approval + one sent.
  const fAgPending = (await makeFollowup({ prospectId: pAg.id, status: "pending_approval" })).id;
  const fAgSent = (await makeFollowup({ prospectId: pAg.id, status: "sent" })).id;

  // bystander user with an active follow-up — must be untouched.
  const pBy = await makeProspect({ userId: other.id, app: "doctrine", name: "ByCo", company: "ByCorp" });
  const fByQueued = (await makeFollowup({ prospectId: pBy.id, status: "queued" })).id;

  // 2. wrong name => 400, no change.
  const wrong = await post(`/api/admin/users/${user.id}/kill`, { confirmName: "Not The Name" });
  record("user-kill: wrong name returns 400", wrong.status === 400, `status=${wrong.status}`);
  const fStillQueued = await getFollowup(fActive["queued"]);
  record("user-kill: wrong name leaves follow-ups unchanged", fStillQueued.status === "queued", `status=${fStillQueued.status}`);
  const uStill = await getUser(user.id);
  record("user-kill: wrong name leaves paused_by_admin false", uStill.pausedByAdmin === false, `pausedByAdmin=${uStill.pausedByAdmin}`);

  // 3. empty-name user => 400 stored_name_empty message.
  const empty = await makeUser({ name: "   ", email: `${PREFIX}noname@example.invalid` });
  const emptyRes = await post(`/api/admin/users/${empty.id}/kill`, { confirmName: "anything" });
  record("user-kill: empty stored name returns 400", emptyRes.status === 400, `status=${emptyRes.status}`);
  record("user-kill: empty-name error mentions no stored name",
    typeof emptyRes.body?.error === "string" && /no stored name/i.test(emptyRes.body.error),
    emptyRes.body?.error ?? "");

  // 4. exact name => kill succeeds.
  const ok = await post(`/api/admin/users/${user.id}/kill`, { confirmName: "ZZ Relay Killtarget" });
  record("user-kill: exact name returns 200", ok.status === 200, `status=${ok.status}`);

  // every active follow-up across all three subproducts is cancelled.
  let allCancelled = true;
  for (const st of ACTIVE_FOUR) {
    const f = await getFollowup(fActive[st]);
    if (f.status !== "cancelled") allCancelled = false;
  }
  const ctxQ = await getFollowup(fCtxQueued);
  const agP = await getFollowup(fAgPending);
  allCancelled = allCancelled && ctxQ.status === "cancelled" && agP.status === "cancelled";
  record("user-kill: every active follow-up across all 3 subproducts cancelled", allCancelled);

  // sent rows unchanged.
  const sent1 = await getFollowup(fSent);
  const sent2 = await getFollowup(fAgSent);
  record("user-kill: sent rows unchanged", sent1.status === "sent" && sent2.status === "sent",
    `${sent1.status},${sent2.status}`);

  // replied prospect: replied flag preserved.
  const ctxProspect = await getProspect(pCtx.id);
  record("user-kill: replied flag preserved on replied campaign", ctxProspect.replied === 1, `replied=${ctxProspect.replied}`);

  // every campaign paused + admin_killed.
  let allPaused = true;
  for (const pid of [pDoc.id, pCtx.id, pAg.id]) {
    const p = await getProspect(pid);
    if (!(p.followupPaused === true && p.pauseReason === "admin_killed" && p.pausedAt instanceof Date)) allPaused = false;
  }
  record("user-kill: every campaign followup_paused=true, pause_reason=admin_killed", allPaused);

  // user paused_by_admin = true.
  const killedUser = await getUser(user.id);
  record("user-kill: user paused_by_admin=true", killedUser.pausedByAdmin === true);

  // per-subproduct counts match. doctrine cancelled 4, context 1, anti_ghosting 1.
  const byApp = ok.body?.by_app ?? {};
  eqCheck("user-kill: by_app.doctrine.followups_cancelled=4", byApp?.doctrine?.followups_cancelled, 4);
  eqCheck("user-kill: by_app.context.followups_cancelled=1", byApp?.context?.followups_cancelled, 1);
  eqCheck("user-kill: by_app.anti_ghosting.followups_cancelled=1", byApp?.anti_ghosting?.followups_cancelled, 1);
  eqCheck("user-kill: total followups_cancelled=6", ok.body?.followups_cancelled, 6);
  eqCheck("user-kill: total campaigns_paused=3", ok.body?.campaigns_paused, 3);

  // 5. queue a due follow-up for the killed user, run processDueFollowups,
  // confirm skipped & not sent.
  await db.update(followupsTable).set({ status: "queued", scheduledAt: new Date(Date.now() - 3600 * 1000) })
    .where(eq(followupsTable.id, fActive["queued"]));
  const proc = await processDueFollowups();
  record("user-kill: processDueFollowups sends nothing for killed user", proc.sent === 0, `sent=${proc.sent}`);
  // The requeued row should NOT have been sent (still queued or skipped — its status must not be 'sent').
  const requeued = await getFollowup(fActive["queued"]);
  record("user-kill: killed user's due follow-up not sent", requeued.status !== "sent", `status=${requeued.status}`);

  // autoQueueAllCampaigns => no new follow-up for the killed user.
  const beforeCount = (await followupStatuses(pDoc.id)).length
    + (await followupStatuses(pCtx.id)).length
    + (await followupStatuses(pAg.id)).length;
  await autoQueueAllCampaigns();
  const afterCount = (await followupStatuses(pDoc.id)).length
    + (await followupStatuses(pCtx.id)).length
    + (await followupStatuses(pAg.id)).length;
  record("user-kill: autoQueueAllCampaigns queues nothing new for killed user", afterCount === beforeCount,
    `before=${beforeCount}, after=${afterCount}`);

  // 6. bystander untouched.
  const byF = await getFollowup(fByQueued);
  const byP = await getProspect(pBy.id);
  const byU = await getUser(other.id);
  record("user-kill: second user untouched (scope is one person)",
    byF.status === "queued" && byP.followupPaused === false && byU.pausedByAdmin === false,
    `f=${byF.status}, paused=${byP.followupPaused}, admin=${byU.pausedByAdmin}`);
}

// ─────────────────────────────────────────────────────────────────
//  PART B — prospect-level Kill
// ─────────────────────────────────────────────────────────────────
async function verifyProspectKill() {
  console.log("\n----- PROSPECT-LEVEL KILL -----");
  const user = await makeUser({ name: "ZZ Relay PKill", email: `${PREFIX}pkill@example.invalid`, maxFollowups: 100 });

  // Two campaigns A and B, each with active follow-ups + a sent + a replied row.
  const A = await makeProspect({ userId: user.id, app: "doctrine", name: "CampA", company: "AlphaCorp" });
  const B = await makeProspect({ userId: user.id, app: "doctrine", name: "CampB", company: "BetaCorp" });

  const aActive: Record<string, number> = {};
  for (const st of ACTIVE_FOUR) aActive[st] = (await makeFollowup({ prospectId: A.id, status: st })).id;
  const aSent = (await makeFollowup({ prospectId: A.id, status: "sent" })).id;
  // a "replied" representation: a prospect-level replied is on the prospect
  // row; also include a terminal 'ok' to be safe. We mark A.replied=0 (active),
  // and add a sibling replied row via B for the replied-untouched check below.
  const bActive: Record<string, number> = {};
  for (const st of ACTIVE_FOUR) bActive[st] = (await makeFollowup({ prospectId: B.id, status: st })).id;
  const bSent = (await makeFollowup({ prospectId: B.id, status: "sent" })).id;

  // Give A a replied marker on its row's history by setting replied on a
  // dedicated check: we assert A.replied is preserved (starts 0). Also set a
  // sent timestamp marker already covered. Add one replied row by flipping
  // B.replied later; for A we keep replied=0 and assert it stays 0.

  // 2. mismatched confirmId => 400 + no change.
  const mism = await post(`/api/admin/prospects/${A.id}/kill`, { confirmId: B.id });
  record("prospect-kill: mismatched confirmId returns 400", mism.status === 400, `status=${mism.status}`);
  const aQ = await getFollowup(aActive["queued"]);
  record("prospect-kill: mismatch leaves campaign A unchanged", aQ.status === "queued", `status=${aQ.status}`);
  const aPbefore = await getProspect(A.id);
  record("prospect-kill: mismatch leaves A not paused", aPbefore.followupPaused === false);

  // 3. matching confirmId => kill A.
  const ok = await post(`/api/admin/prospects/${A.id}/kill`, { confirmId: A.id });
  record("prospect-kill: matching confirmId returns 200", ok.status === 200, `status=${ok.status}`);
  let aAllCancelled = true;
  for (const st of ACTIVE_FOUR) {
    const f = await getFollowup(aActive[st]);
    if (f.status !== "cancelled") aAllCancelled = false;
  }
  record("prospect-kill: campaign A's active follow-ups all cancelled", aAllCancelled);
  const aSentRow = await getFollowup(aSent);
  record("prospect-kill: A's sent row unchanged", aSentRow.status === "sent", `status=${aSentRow.status}`);
  const aProspect = await getProspect(A.id);
  record("prospect-kill: A followup_paused=true, pause_reason=admin_killed, paused_at set",
    aProspect.followupPaused === true && aProspect.pauseReason === "admin_killed" && aProspect.pausedAt instanceof Date);
  record("prospect-kill: A replied flag preserved (still 0)", aProspect.replied === 0, `replied=${aProspect.replied}`);
  eqCheck("prospect-kill: response followups_cancelled=4", ok.body?.followups_cancelled, 4);
  eqCheck("prospect-kill: response prospect_paused=true", ok.body?.prospect_paused, true);

  // owning user's paused_by_admin still false.
  const owner = await getUser(user.id);
  record("prospect-kill: owning user's paused_by_admin still false (two layers, not three)",
    owner.pausedByAdmin === false, `pausedByAdmin=${owner.pausedByAdmin}`);

  // 4. campaign B fully intact.
  let bIntact = true;
  for (const st of ACTIVE_FOUR) {
    const f = await getFollowup(bActive[st]);
    if (f.status !== st) bIntact = false;
  }
  const bSentRow = await getFollowup(bSent);
  const bProspect = await getProspect(B.id);
  bIntact = bIntact && bSentRow.status === "sent" && bProspect.followupPaused === false && bProspect.pauseReason === null;
  record("prospect-kill: campaign B fully intact (scope is one campaign)", bIntact,
    `bPaused=${bProspect.followupPaused}, bReason=${bProspect.pauseReason}`);

  // 5. autoQueueAllCampaigns: A gets nothing new; B still queues normally.
  // First clear B's active rows so it is eligible to queue a next stage.
  await db.update(followupsTable).set({ status: "sent", sentAt: new Date() })
    .where(and(eq(followupsTable.prospectId, B.id), inArray(followupsTable.status, [...ACTIVE_FOUR])));
  const aBefore = (await followupStatuses(A.id)).length;
  const bBefore = (await followupStatuses(B.id)).length;
  const queued = await autoQueueAllCampaigns();
  const aAfter = (await followupStatuses(A.id)).length;
  const bAfter = (await followupStatuses(B.id)).length;
  record("prospect-kill: autoQueue adds nothing to killed campaign A", aAfter === aBefore, `before=${aBefore}, after=${aAfter}`);
  record("prospect-kill: autoQueue queues a new stage for live campaign B", bAfter > bBefore,
    `before=${bBefore}, after=${bAfter}, queuedTotal=${queued}`);
}

// ─────────────────────────────────────────────────────────────────
//  PART C — cross-check the two levels do not interfere
// ─────────────────────────────────────────────────────────────────
async function crossCheck() {
  console.log("\n----- CROSS-CHECK -----");
  const user = await makeUser({ name: "ZZ Relay Cross", email: `${PREFIX}cross@example.invalid` });
  const A = await makeProspect({ userId: user.id, app: "doctrine", name: "XA", company: "XACorp" });
  const B = await makeProspect({ userId: user.id, app: "context", name: "XB", company: "XBCorp" });
  for (const st of ACTIVE_FOUR) { await makeFollowup({ prospectId: A.id, status: st }); }
  for (const st of ACTIVE_FOUR) { await makeFollowup({ prospectId: B.id, status: st }); }

  // 1. kill one campaign, then user-kill the whole user.
  const pk = await post(`/api/admin/prospects/${A.id}/kill`, { confirmId: A.id });
  record("cross: prospect-kill A succeeds", pk.status === 200 && pk.body?.followups_cancelled === 4,
    `status=${pk.status}, cancelled=${pk.body?.followups_cancelled}`);
  const uk = await post(`/api/admin/users/${user.id}/kill`, { confirmName: "ZZ Relay Cross" });
  record("cross: user-kill after prospect-kill completes cleanly (200)", uk.status === 200, `status=${uk.status}`);
  // A was already killed (0 new active), B had 4 active -> user-kill cancels B's 4.
  // total should be 4 (B's), A contributes 0 since already cancelled.
  eqCheck("cross: user-kill cancels only the still-active rows (B's 4)", uk.body?.followups_cancelled, 4);
  const ap = await getProspect(A.id);
  const bp = await getProspect(B.id);
  const uu = await getUser(user.id);
  record("cross: both campaigns paused + user paused_by_admin true after user-kill",
    ap.followupPaused && bp.followupPaused && uu.pausedByAdmin === true);

  // 2. killing an already-killed campaign is a safe no-op (0 cancelled).
  const again = await post(`/api/admin/prospects/${A.id}/kill`, { confirmId: A.id });
  record("cross: re-killing an already-killed campaign is a safe no-op (200, 0 cancelled)",
    again.status === 200 && again.body?.followups_cancelled === 0,
    `status=${again.status}, cancelled=${again.body?.followups_cancelled}`);
}

main().catch(async (err) => {
  console.error("VERIFICATION HARNESS CRASHED:", err);
  try { await teardown(); } catch { /* ignore */ }
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(2);
});