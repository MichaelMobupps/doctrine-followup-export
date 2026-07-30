import { db, prospectsTable, usersTable, followupsTable } from "@workspace/db";
import { eq, and, sql, isNull } from "drizzle-orm";
import {
  fetchLabeledSentEmails,
  checkThreadForReplies,
  extractEmail,
  extractName,
  extractRecipientFirstNameFromBody,
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

/**
 * Maximum characters of the original body we retain on the prospects row.
 * 3000 chars comfortably covers a full cold-outreach email (typical 150-400
 * words). Above this we cut with word-boundary alignment so we don't end
 * mid-sentence.
 */
const MAX_ORIGINAL_BODY_CHARS = 3000;

function prepareOriginalBody(raw: string): string {
  if (!raw) return "";
  // Strip HTML, collapse whitespace, trim. We keep Unicode letters intact.
  let cleaned = raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (cleaned.length > MAX_ORIGINAL_BODY_CHARS) {
    cleaned = cleaned.slice(0, MAX_ORIGINAL_BODY_CHARS).replace(/\s+\S*$/, "");
  }
  return cleaned;
}

/**
 * Domains where the email host is NOT the recipient's employer.
 * For these, we must not label the prospect as working at "Gmail" etc.
 * The list covers the most common consumer webmail providers worldwide.
 */
const FREE_EMAIL_DOMAINS = new Set<string>([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "yahoo.co.jp", "yahoo.fr",
  "yahoo.de", "yahoo.es", "yahoo.it", "ymail.com", "rocketmail.com",
  "outlook.com", "outlook.co.uk", "hotmail.com", "hotmail.co.uk",
  "hotmail.fr", "hotmail.de", "hotmail.it", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com",
  "aol.com", "aim.com",
  "proton.me", "protonmail.com", "pm.me",
  "yandex.com", "yandex.ru",
  "mail.com", "mail.ru", "inbox.ru", "list.ru", "bk.ru",
  "gmx.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch",
  "web.de", "t-online.de", "freenet.de",
  "fastmail.com", "fastmail.fm", "zoho.com",
  "qq.com", "163.com", "126.com", "sina.com", "sina.cn", "sohu.com",
  "naver.com", "daum.net", "hanmail.net", "kakao.com",
  "rediffmail.com",
  "walla.co.il", "walla.com",
]);

function inferCompany(email: string): string {
  const domain = (email.split("@")[1] || "").toLowerCase();
  if (!domain) return "";
  if (FREE_EMAIL_DOMAINS.has(domain)) return "";
  const name = domain.split(".")[0] || "";
  if (!name) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}


async function syncForUser(user: {
  id: number;
  email: string;
  name: string;
  googleRefreshToken: string;
  doctrineLabel: string;
}): Promise<{ synced: number; repliesDetected: number }> {
  const creds: GmailCredentials = {
    refreshToken: user.googleRefreshToken,
    email: user.email,
    name: user.name,
  };
  const gmail = getGmailForUser(creds);

  const labels = user.doctrineLabel.split(",").map((l) => l.trim()).filter(Boolean);

  await ensureLabelsExist(labels, gmail);

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const afterDate = sixtyDaysAgo.toISOString().split("T")[0].replace(/-/g, "/");

  logger.info({ labels, afterDate, userId: user.id, email: user.email }, "Syncing emails for user");
  const messages = await fetchLabeledSentEmails(labels, afterDate, gmail);
  logger.info({ count: messages.length, userId: user.id }, "Found labeled sent emails");

  let synced = 0;
  let conflicts = 0;
  let skipped = 0;
  for (const msg of messages) {
    // Skip messages we've already ingested. Without this check, every
    // 15-minute sync re-runs the LLM summarizer on every email in the 60-day
    // Gmail window — the downstream onConflictDoNothing prevents duplicate
    // rows but does NOT prevent the summarizer call that precedes it. Sent
    // email bodies are immutable, so a one-time summarization per message
    // is sufficient forever after.
    const existing = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(eq(prospectsTable.gmailMessageId, msg.id))
      .limit(1);
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const recipientEmail = extractEmail(msg.to);
    const recipientName = extractRecipientFirstNameFromBody(msg.body) || extractName(msg.to);
    const { vertical, subVertical } = inferVertical(msg.labels, msg.subject, msg.body);
    const { summary: bodySummary, language: originalLanguage } = await summarizeOriginalEmail(msg.body);

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
        originalBody: prepareOriginalBody(msg.body),
        originalLanguage,
        batchLabel: user.doctrineLabel,
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

  logger.info({ synced, skipped, conflicts, repliesDetected, userId: user.id }, "Sync complete for user");
  return { synced, repliesDetected };
}

/**
 * Sync emails for a single connected user, identified by email.
 *
 * This is the path used by the per-user "Sync Gmail now" button in the
 * Apps Script add-on. The clicker's request only waits for their own
 * mailbox — it does NOT block on syncing other tenants' accounts.
 *
 * Throws on lookup or connection failures so the route handler can
 * translate to an HTTP error.
 */
export async function syncEmailsForUser(email: string): Promise<{
  synced: number;
  repliesDetected: number;
}> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Email is required for per-user sync");
  }

  // Case-insensitive lookup. The OAuth callback in routes/gmail-auth.ts
  // stores whatever Google returns from userinfo.get() verbatim, which
  // can be mixed-case for some Workspace tenants. The addon button
  // sends the active user's email which Apps Script also doesn't
  // normalize. Comparing on LOWER(email) avoids spurious 404s for users
  // whose stored row has any case variation.
  const matches = await db
    .select()
    .from(usersTable)
    .where(sql`LOWER(${usersTable.email}) = ${normalized}`)
    .limit(1);

  const user = matches[0];
  if (!user) {
    const err = new Error(`No connected account found for ${email}`);
    (err as any).statusCode = 404;
    throw err;
  }
  if (!user.isConnected || !user.googleRefreshToken) {
    const err = new Error(
      `Account ${email} is not connected. Reconnect via the dashboard.`,
    );
    (err as any).statusCode = 400;
    throw err;
  }

  return syncForUser({
    id: user.id,
    email: user.email,
    name: user.name,
    googleRefreshToken: user.googleRefreshToken,
    doctrineLabel: user.doctrineLabel,
  });
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
  let skipped = 0;
  for (const msg of messages) {
    // Skip messages we've already ingested. See matching comment in
    // syncForUser above — this prevents the LLM summarizer from re-running
    // on every email in the 60-day window on every 15-minute sync tick.
    const existing = await db
      .select({ id: prospectsTable.id })
      .from(prospectsTable)
      .where(eq(prospectsTable.gmailMessageId, msg.id))
      .limit(1);
    if (existing.length > 0) {
      skipped++;
      continue;
    }

    const recipientEmail = extractEmail(msg.to);
    const recipientName = extractRecipientFirstNameFromBody(msg.body) || extractName(msg.to);
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
        originalBody: prepareOriginalBody(msg.body),
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

  logger.info({ synced, skipped, repliesDetected }, "Sync complete (legacy)");
  return { synced, repliesDetected };
}
