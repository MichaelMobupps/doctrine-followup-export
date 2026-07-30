import { db, prospectsTable, usersTable } from "@workspace/db";
import { eq, and, sql, isNull } from "drizzle-orm";
import { followupsTable } from "@workspace/db";
import { TEST_MODE_LABEL } from "../lib/constants";
import {
  fetchLabeledSentEmails,
  checkThreadForReplies,
  extractEmail,
  extractName,
  getGmailForUser,
  ensureLabelsExist,
} from "./gmailClient";
import type { GmailCredentials } from "./gmailClient";
import { inferVertical } from "../lib/verticalClassifier";
import { summarizeOriginalEmail } from "./emailSummarizer";
import { logger } from "../lib/logger";

function inferProduct(vertical: string): string {
  if (vertical === "retargeting") return "retargeting";
  if (vertical === "cps") return "cps";
  return "ua";
}

function inferCompany(email: string): string {
  const domain = email.split("@")[1] || "";
  const name = domain.split(".")[0] || "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}


async function syncForUser(user: {
  id: number;
  email: string;
  name: string;
  googleRefreshToken: string;
  doctrineLabel: string;
  testMode?: boolean;
}): Promise<{ synced: number; repliesDetected: number }> {
  const creds: GmailCredentials = {
    refreshToken: user.googleRefreshToken,
    email: user.email,
    name: user.name,
  };
  const gmail = getGmailForUser(creds);

  const prodLabels = user.doctrineLabel.split(",").map((l) => l.trim());
  const allLabels = new Set(prodLabels);
  if (user.testMode) {
    allLabels.add(TEST_MODE_LABEL);
  }
  const labels = Array.from(allLabels);

  const labelIdToName = await ensureLabelsExist(labels, gmail);

  const testLabelId = Array.from(labelIdToName.entries()).find(
    ([, name]) => name === TEST_MODE_LABEL
  )?.[0];

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const afterDate = sixtyDaysAgo.toISOString().split("T")[0].replace(/-/g, "/");

  logger.info({ labels, afterDate, userId: user.id, email: user.email }, "Syncing emails for user");
  const messages = await fetchLabeledSentEmails(labels, afterDate, gmail);
  logger.info({ count: messages.length, userId: user.id }, "Found labeled sent emails");

  let synced = 0;
  let conflicts = 0;
  for (const msg of messages) {
    const recipientEmail = extractEmail(msg.to);
    const recipientName = extractName(msg.to);
    const { vertical, subVertical } = inferVertical(msg.labels, msg.subject, msg.body);
    const { summary: bodySummary, language: originalLanguage } = await summarizeOriginalEmail(msg.body);

    const isTestEmail = testLabelId ? msg.labels.includes(testLabelId) : false;
    const msgBatchLabel = isTestEmail ? TEST_MODE_LABEL : user.doctrineLabel;

    const insertResult = await db
      .insert(prospectsTable)
      .values({
        userId: user.id,
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId,
        prospectName: recipientName,
        company: inferCompany(recipientEmail),
        email: recipientEmail,
        vertical,
        subVertical,
        product: inferProduct(vertical),
        subject: msg.subject,
        originalBodySummary: bodySummary,
        originalLanguage,
        batchLabel: msgBatchLabel,
        sentAt: new Date(msg.date),
      })
      .onConflictDoNothing({ target: prospectsTable.gmailMessageId });
    if (insertResult.rowCount && insertResult.rowCount > 0) synced++;
    else conflicts++;
  }

  const unreplied = await db
    .selectDistinct({ gmailThreadId: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .where(
      and(
        eq(prospectsTable.replied, 0),
        eq(prospectsTable.userId, user.id),
      ),
    );

  let repliesDetected = 0;
  for (const row of unreplied) {
    try {
      const hasReply = await checkThreadForReplies(row.gmailThreadId, user.email, gmail);
      if (hasReply) {
        await db
          .update(prospectsTable)
          .set({ replied: 1, repliedAt: new Date(), followupPaused: true })
          .where(
            and(
              eq(prospectsTable.gmailThreadId, row.gmailThreadId),
              eq(prospectsTable.userId, user.id),
              eq(prospectsTable.replied, 0),
            ),
          );

        await db
          .update(followupsTable)
          .set({ status: "cancelled" })
          .where(
            and(
              sql`${followupsTable.prospectId} IN (SELECT id FROM prospects WHERE gmail_thread_id = ${row.gmailThreadId} AND user_id = ${user.id})`,
              eq(followupsTable.status, "queued"),
            ),
          );

        repliesDetected++;
      }
    } catch (err) {
      logger.error(
        { err, threadId: row.gmailThreadId, userId: user.id },
        "Reply check failed for thread",
      );
    }
  }

  logger.info({ synced, repliesDetected, userId: user.id }, "Sync complete for user");
  return { synced, repliesDetected };
}

export async function syncEmails(): Promise<{
  synced: number;
  repliesDetected: number;
}> {
  const connectedUsers = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isConnected, true));

  if (connectedUsers.length === 0) {
    const fallbackToken = process.env.GOOGLE_REFRESH_TOKEN;
    const fallbackEmail = process.env.SENDER_EMAIL;
    if (fallbackToken && fallbackEmail) {
      logger.info("No connected users — using legacy env var credentials");
      return syncForLegacyUser(fallbackToken, fallbackEmail);
    }
    logger.info("No connected users and no legacy credentials — skipping sync");
    return { synced: 0, repliesDetected: 0 };
  }

  let totalSynced = 0;
  let totalReplies = 0;

  for (const user of connectedUsers) {
    if (!user.googleRefreshToken) continue;
    try {
      const result = await syncForUser({
        id: user.id,
        email: user.email,
        name: user.name,
        googleRefreshToken: user.googleRefreshToken,
        doctrineLabel: user.doctrineLabel,
        testMode: user.testMode,
      });
      totalSynced += result.synced;
      totalReplies += result.repliesDetected;
    } catch (err) {
      logger.error({ err, userId: user.id, email: user.email }, "Sync failed for user");
    }
  }

  return { synced: totalSynced, repliesDetected: totalReplies };
}

async function syncForLegacyUser(
  refreshToken: string,
  senderEmail: string,
): Promise<{ synced: number; repliesDetected: number }> {
  const creds: GmailCredentials = { refreshToken, email: senderEmail };
  const gmail = getGmailForUser(creds);

  const labels = (process.env.DOCTRINE_LABELS || "doctrine")
    .split(",")
    .map((l) => l.trim());

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const afterDate = sixtyDaysAgo.toISOString().split("T")[0].replace(/-/g, "/");

  logger.info({ labels, afterDate }, "Syncing emails (legacy mode)");
  const messages = await fetchLabeledSentEmails(labels, afterDate, gmail);
  logger.info({ count: messages.length }, "Found labeled sent emails");

  let synced = 0;
  for (const msg of messages) {
    const recipientEmail = extractEmail(msg.to);
    const recipientName = extractName(msg.to);
    const { vertical, subVertical } = inferVertical(msg.labels, msg.subject, msg.body);
    const { summary: bodySummary, language: originalLanguage } = await summarizeOriginalEmail(msg.body);

    const insertResult = await db
      .insert(prospectsTable)
      .values({
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId,
        prospectName: recipientName,
        company: inferCompany(recipientEmail),
        email: recipientEmail,
        vertical,
        subVertical,
        product: inferProduct(vertical),
        subject: msg.subject,
        originalBodySummary: bodySummary,
        originalLanguage,
        batchLabel: labels[0],
        sentAt: new Date(msg.date),
      })
      .onConflictDoNothing({ target: prospectsTable.gmailMessageId });
    if (insertResult.rowCount && insertResult.rowCount > 0) synced++;
  }

  const unreplied = await db
    .selectDistinct({ gmailThreadId: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .where(
      and(
        eq(prospectsTable.replied, 0),
        isNull(prospectsTable.userId),
      ),
    );

  let repliesDetected = 0;
  for (const row of unreplied) {
    try {
      const hasReply = await checkThreadForReplies(row.gmailThreadId, senderEmail, gmail);
      if (hasReply) {
        await db
          .update(prospectsTable)
          .set({ replied: 1, repliedAt: new Date(), followupPaused: true })
          .where(
            and(
              eq(prospectsTable.gmailThreadId, row.gmailThreadId),
              isNull(prospectsTable.userId),
              eq(prospectsTable.replied, 0),
            ),
          );

        await db
          .update(followupsTable)
          .set({ status: "cancelled" })
          .where(
            and(
              sql`${followupsTable.prospectId} IN (SELECT id FROM prospects WHERE gmail_thread_id = ${row.gmailThreadId} AND user_id IS NULL)`,
              eq(followupsTable.status, "queued"),
            ),
          );

        repliesDetected++;
      }
    } catch (err) {
      logger.error(
        { err, threadId: row.gmailThreadId },
        "Reply check failed for thread",
      );
    }
  }

  logger.info({ synced, repliesDetected }, "Sync complete (legacy)");
  return { synced, repliesDetected };
}
