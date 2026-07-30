/**
 * backfillLabels.ts — One-time backfill for users whose sent emails
 * were never labeled due to the per-mailbox label ID bug.
 *
 * Usage:
 *   npx tsx api-server/scripts/backfillLabels.ts                    # dry-run, all connected users
 *   npx tsx api-server/scripts/backfillLabels.ts --apply            # apply labels for all connected users
 *   npx tsx api-server/scripts/backfillLabels.ts --email murat@mobupps.com          # dry-run, single user
 *   npx tsx api-server/scripts/backfillLabels.ts --email murat@mobupps.com --apply  # apply labels, single user
 *   npx tsx api-server/scripts/backfillLabels.ts --days 90          # look back 90 days instead of default 60
 *
 * What it does:
 *   1. Reads connected users from the DB (or a single user via --email)
 *   2. For each user, authenticates as that user via their stored refresh token
 *   3. Ensures the "Doctrine SDR" label exists on their mailbox (creates it if missing)
 *   4. Lists all sent emails from the lookback window
 *   5. Filters to emails NOT already labeled "Doctrine SDR"
 *   6. In --apply mode, labels each unlabeled sent email with "Doctrine SDR"
 *
 * Safe to run multiple times — already-labeled messages are skipped.
 */

import { google } from "googleapis";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ── Config ──────────────────────────────────────────────────────────

const LABEL_NAME = "Doctrine SDR";
const DEFAULT_LOOKBACK_DAYS = 60;
const BATCH_SIZE = 100;

// ── CLI args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const applyMode = args.includes("--apply");
const emailFlag = args.indexOf("--email");
const targetEmail = emailFlag !== -1 ? args[emailFlag + 1] : null;
const daysFlag = args.indexOf("--days");
const lookbackDays = daysFlag !== -1 ? parseInt(args[daysFlag + 1]) || DEFAULT_LOOKBACK_DAYS : DEFAULT_LOOKBACK_DAYS;

// ── Helpers ─────────────────────────────────────────────────────────

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
}

function getGmailForToken(refreshToken: string) {
  const auth = getOAuth2Client();
  auth.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth });
}

/**
 * Ensure the label exists on this user's mailbox. Returns the label ID.
 */
async function ensureLabel(
  gmail: ReturnType<typeof google.gmail>,
  labelName: string,
): Promise<string | null> {
  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = res.data.labels || [];

  for (const label of labels) {
    if (label.name?.toLowerCase() === labelName.toLowerCase() && label.id) {
      return label.id;
    }
  }

  // Doesn't exist — create it
  try {
    const created = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    console.log(`  + Created label "${labelName}" (ID: ${created.data.id})`);
    return created.data.id || null;
  } catch (err: any) {
    if (err.code === 409) {
      // Race condition — re-fetch
      const retry = await gmail.users.labels.list({ userId: "me" });
      const found = (retry.data.labels || []).find(
        (l) => l.name?.toLowerCase() === labelName.toLowerCase()
      );
      return found?.id || null;
    }
    console.error(`  [fail] Could not create label "${labelName}": ${err.message}`);
    return null;
  }
}

/**
 * List all sent message IDs in the lookback window.
 */
async function listSentMessages(
  gmail: ReturnType<typeof google.gmail>,
  afterDate: string,
): Promise<Array<{ id: string; labelIds: string[] }>> {
  const results: Array<{ id: string; labelIds: string[] }> = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: `in:sent after:${afterDate}`,
      maxResults: BATCH_SIZE,
      pageToken,
    });

    const items = res.data.messages || [];
    for (const item of items) {
      if (!item.id) continue;
      // Fetch just labelIds (minimal data)
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: item.id,
        format: "minimal",
      });
      results.push({
        id: item.id,
        labelIds: msg.data.labelIds || [],
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function backfillForUser(user: {
  id: number;
  email: string;
  googleRefreshToken: string;
}): Promise<{ found: number; unlabeled: number; labeled: number }> {
  console.log(`\n── ${user.email} (userId=${user.id}) ──`);

  const gmail = getGmailForToken(user.googleRefreshToken);

  // Step 1: Ensure label exists, get its ID
  const labelId = await ensureLabel(gmail, LABEL_NAME);
  if (!labelId) {
    console.log(`  [skip] Could not resolve label — skipping user`);
    return { found: 0, unlabeled: 0, labeled: 0 };
  }
  console.log(`  Label "${LABEL_NAME}" → ID: ${labelId}`);

  // Step 2: List sent messages
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lookbackDays);
  const afterDate = cutoff.toISOString().split("T")[0].replace(/-/g, "/");

  console.log(`  Scanning sent emails after ${afterDate}...`);
  const messages = await listSentMessages(gmail, afterDate);
  console.log(`  Found ${messages.length} sent messages`);

  // Step 3: Filter to unlabeled
  const unlabeled = messages.filter((m) => !m.labelIds.includes(labelId));
  console.log(`  ${unlabeled.length} missing the "${LABEL_NAME}" label`);

  if (unlabeled.length === 0) {
    return { found: messages.length, unlabeled: 0, labeled: 0 };
  }

  if (!applyMode) {
    console.log(`  [dry-run] Would label ${unlabeled.length} messages. Run with --apply to execute.`);
    return { found: messages.length, unlabeled: unlabeled.length, labeled: 0 };
  }

  // Step 4: Apply label
  let labeled = 0;
  for (const msg of unlabeled) {
    try {
      await gmail.users.messages.modify({
        userId: "me",
        id: msg.id,
        requestBody: {
          addLabelIds: [labelId],
        },
      });
      labeled++;
      if (labeled % 25 === 0) {
        console.log(`  ...labeled ${labeled}/${unlabeled.length}`);
      }
    } catch (err: any) {
      console.error(`  [fail] Message ${msg.id}: ${err.message}`);
    }
  }

  console.log(`  Labeled ${labeled}/${unlabeled.length} messages`);
  return { found: messages.length, unlabeled: unlabeled.length, labeled };
}

async function main() {
  console.log(`\n=== Doctrine SDR Label Backfill ===`);
  console.log(`Mode: ${applyMode ? "APPLY" : "DRY-RUN"}`);
  console.log(`Lookback: ${lookbackDays} days`);
  if (targetEmail) console.log(`Target: ${targetEmail}`);

  // Fetch users
  let users;
  if (targetEmail) {
    users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, targetEmail))
      .limit(1);
    if (users.length === 0) {
      console.error(`\nNo user found with email: ${targetEmail}`);
      process.exit(1);
    }
  } else {
    users = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.isConnected, true));
  }

  const connectedUsers = users.filter((u) => u.googleRefreshToken);
  if (connectedUsers.length === 0) {
    console.log("\nNo connected users with refresh tokens found.");
    process.exit(0);
  }

  console.log(`\nProcessing ${connectedUsers.length} user(s)...`);

  let totalFound = 0;
  let totalUnlabeled = 0;
  let totalLabeled = 0;

  for (const user of connectedUsers) {
    try {
      const result = await backfillForUser({
        id: user.id,
        email: user.email,
        googleRefreshToken: user.googleRefreshToken!,
      });
      totalFound += result.found;
      totalUnlabeled += result.unlabeled;
      totalLabeled += result.labeled;
    } catch (err: any) {
      console.error(`\n  [fail] ${user.email}: ${err.message}`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`  Sent messages scanned: ${totalFound}`);
  console.log(`  Missing label:         ${totalUnlabeled}`);
  console.log(`  Labels applied:        ${totalLabeled}`);
  if (!applyMode && totalUnlabeled > 0) {
    console.log(`\n  Re-run with --apply to label these messages.`);
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error("Fatal:", err.message);
    process.exit(1);
  })
  .finally(() => {
    process.exit(0);
  });
