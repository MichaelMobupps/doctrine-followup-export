/**
 * Read-only AntiGhosting diagnostic (all-users mode).
 *
 * Prints the live values every AntiGhosting code path depends on, for every
 * connected user, so the root cause of "labeled threads not read",
 * "context window fails", and "inspector finds no labels" is visible in one
 * run, and so it is clear whether the problem is universal or per-user.
 *
 * No writes. No prod side effects. Safe to run any time.
 *
 * Place at: artifacts/api-server/scripts/diagnose-antighosting.ts
 * Run all connected users:  npx tsx artifacts/api-server/scripts/diagnose-antighosting.ts
 * Deep-dive one user:       npx tsx artifacts/api-server/scripts/diagnose-antighosting.ts someone@mobupps.com
 */

import { db, usersTable, prospectsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { getGmailForUser } from "../src/services/gmailClient";
import { resolveAntiGhostingLabelIds } from "../src/services/antiGhostingIngest";
import {
  validateThreadForMarking,
  parseGmailThread,
} from "../src/services/antiGhostingValidators";

const ARG = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
const ONLY_EMAIL = ARG ? ARG.trim().toLowerCase() : null;
const MAX_THREADS_PER_USER = 5;
const log = (s = "") => console.log(s);

function maskDbTarget(): string {
  const raw = process.env.DATABASE_URL || "";
  if (!raw) return "(DATABASE_URL not set in this shell)";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
  } catch {
    return "(DATABASE_URL set but unparseable)";
  }
}

async function diagnoseUser(user: any, force = false) {
  log("");
  log("------------------------------------------------------------");
  log(`USER id=${user.id}  email=>>>${user.email}<<<`);
  log(`    isConnected: ${user.isConnected}   hasToken: ${Boolean(user.googleRefreshToken)}`);
  log(`    anti_ghosting_label: >>>${user.antiGhostingLabel}<<<  (len ${(user.antiGhostingLabel || "").length})`);

  if (!user.googleRefreshToken) {
    log("    SKIP: no refresh token on this row. Reconnect Gmail in the app.");
    return;
  }
  if (!user.isConnected && !force) {
    log("    SKIP: row marked disconnected. Re-run with this email as an argument to test its token.");
    return;
  }
  if (!user.isConnected && force) {
    log("    NOTE: row is disconnected. Testing the stored token read-only below.");
    log("          If the Gmail calls SUCCEED, a flag flip to connected is safe.");
    log("          If they FAIL with an auth error, you must reconnect in the app.");
  }

  const gmail = getGmailForUser({
    refreshToken: user.googleRefreshToken,
    email: user.email,
    name: user.name ?? undefined,
  });

  let labels: any[] = [];
  try {
    const labelsRes = await gmail.users.labels.list({ userId: "me" });
    labels = labelsRes.data.labels || [];
  } catch (err: any) {
    log(`    labels.list FAILED -> ${err?.message || String(err)}`);
    log("    ^ this user's Gmail token is likely expired. Reconnect in the app.");
    return;
  }
  const ghostish = labels.filter((l) => (l.name || "").toLowerCase().includes("ghost"));
  log(`    gmail labels: ${labels.length}   'ghost' matches: ${ghostish.length}`);
  for (const l of ghostish) log(`      candidate: id=${l.id}  name=>>>${l.name}<<<`);

  const labelIds = await resolveAntiGhostingLabelIds(gmail, user.antiGhostingLabel);
  log(`    [3] resolve -> ${labelIds.length} id(s): ${JSON.stringify(labelIds)}`);
  if (labelIds.length === 0) {
    log("    VERDICT: configured label does NOT match a Gmail label (explains issues 1 and 3).");
    return;
  }

  const threadsRes = await gmail.users.threads.list({ userId: "me", labelIds, maxResults: 50 });
  const threads = threadsRes.data.threads || [];
  log(`    [4] labeled threads: ${threads.length}`);
  if (threads.length === 0) {
    log("    VERDICT: label resolves but no thread carries it right now.");
    return;
  }

  const alreadyRows = await db
    .select({ t: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .where(and(eq(prospectsTable.userId, user.id), eq(prospectsTable.app, "anti_ghosting")));
  const alreadyIds = new Set(alreadyRows.map((r) => r.t).filter(Boolean) as string[]);

  const deep = ONLY_EMAIL ? threads : threads.slice(0, MAX_THREADS_PER_USER);
  log(`    [5] checking ${deep.length} thread(s) (parse = issue 2 path, validators = issue 1 gate):`);
  for (const t of deep) {
    if (!t.id) continue;
    log(`      thread ${t.id}${alreadyIds.has(t.id) ? "  (already a prospect)" : ""}`);
    try {
      const briefs = await parseGmailThread(gmail, t.id, user.email);
      const last = briefs[briefs.length - 1];
      log(`        parse: OK, ${briefs.length} msg(s), most-recent = ${last ? last.direction : "n/a"}`);
    } catch (err: any) {
      log(`        parse: FAILED -> ${err?.message || String(err)}   <-- issue 2 real error`);
    }
    try {
      const v = await validateThreadForMarking(t.id, gmail, user.email, user.id);
      log(`        validators: ok=${v.ok}${v.ok ? "" : `  reason="${v.failureReason}"`}`);
    } catch (err: any) {
      log(`        validators: THREW -> ${err?.message || String(err)}`);
    }
  }
}

async function main() {
  log("");
  log("=== AntiGhosting diagnostic (all-users) ===");
  log(`DB target: ${maskDbTarget()}`);

  const users = await db.select().from(usersTable);
  log(`users in this database: ${users.length}`);

  if (users.length === 0) {
    log("");
    log("STOP: this database has no users. The shell is pointed at a different");
    log("database than the running server. Run this where the server's");
    log("DATABASE_URL is set (same env the app uses).");
    process.exit(0);
  }

  log("");
  log("id | connected | hasToken | anti_ghosting_label | email");
  for (const u of users) {
    log(
      `${u.id} | ${u.isConnected} | ${Boolean(u.googleRefreshToken)} | ` +
        `>>>${u.antiGhostingLabel}<<< | >>>${u.email}<<<`,
    );
  }

  let targets = users;
  if (ONLY_EMAIL) {
    targets = users.filter((u) => (u.email || "").trim().toLowerCase() === ONLY_EMAIL);
    if (targets.length === 0) {
      log("");
      log(`STOP: no user matches "${ONLY_EMAIL}". Pick an email from the list above.`);
      process.exit(0);
    }
  } else {
    targets = users.filter((u) => u.isConnected && u.googleRefreshToken);
    log("");
    log(`sweeping ${targets.length} connected user(s)...`);
  }

  for (const u of targets) {
    await diagnoseUser(u, Boolean(ONLY_EMAIL));
  }

  log("");
  log("=== end ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err?.message || err);
  process.exit(1);
});
