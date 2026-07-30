import { db, prospectsTable, usersTable, followupsTable } from "@workspace/db";
import { eq, ne, and, or, sql, isNull, inArray } from "drizzle-orm";
import {
  fetchLabeledSentEmails,
  classifyThreadInbound,
  extractEmail,
  extractName,
  extractRecipientFirstNameFromBody,
  getGmailForUser,
  ensureLabelsExist,
  detectManualFollowupSend,
} from "./gmailClient";
import type { GmailCredentials } from "./gmailClient";
import { inferVertical } from "../lib/verticalClassifier";
import { summarizeOriginalEmail } from "./emailSummarizer";
import { logger } from "../lib/logger";
// B9b.4: AntiGhosting auto-ingest orchestrator. Lists labeled
// threads and ingests each unmarked one via the shared service.
import { ingestAntiGhostingLabeledThreads } from "./antiGhostingIngest";
import { cancelActiveFollowupsForProspects, queueNextFollowupStageForProspect } from "./scheduler";

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

async function reconcileDraftedFollowupsForUser(
  user: { id: number; email: string },
  gmail: ReturnType<typeof getGmailForUser>,
): Promise<{ draftsSent: number; customOutbounds: number }> {
  const draftedFollowups = await db
    .select({
      followupId: followupsTable.id,
      prospectId: followupsTable.prospectId,
      stage: followupsTable.stage,
      scheduledAt: followupsTable.scheduledAt,
      generatedBody: followupsTable.generatedBody,
      gmailMessageId: followupsTable.gmailMessageId,
      gmailThreadId: prospectsTable.gmailThreadId,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(
      and(
        eq(followupsTable.status, "drafted"),
        eq(prospectsTable.userId, user.id),
        eq(prospectsTable.replied, 0),
        eq(prospectsTable.followupPaused, false),
      ),
    );

  let draftsSent = 0;
  let customOutbounds = 0;

  for (const row of draftedFollowups) {
    try {
      const detection = await detectManualFollowupSend({
        threadId: row.gmailThreadId,
        senderEmail: user.email,
        after: row.scheduledAt,
        followupId: row.followupId,
        generatedBody: row.generatedBody,
        gmail,
      });

      if (detection.kind === "none") continue;

      if (detection.kind === "draft_sent") {
        const sentAt = detection.sentAt || new Date();
        const updateResult = await db
          .update(followupsTable)
          .set({
            status: "sent",
            sentAt,
            gmailMessageId: detection.messageId || row.gmailMessageId,
            draftMessageId: null,
            errorMessage: null,
          })
          .where(and(eq(followupsTable.id, row.followupId), eq(followupsTable.status, "drafted")));

        if (updateResult.rowCount && updateResult.rowCount > 0) {
          draftsSent++;
          const queued = await queueNextFollowupStageForProspect(row.prospectId);
          logger.info(
            {
              followupId: row.followupId,
              prospectId: row.prospectId,
              stage: row.stage,
              gmailMessageId: detection.messageId,
              nextStageQueued: queued.queued,
              nextStage: queued.stage,
              nextStageReason: queued.reason,
            },
            "Detected manually sent Gmail follow-up draft",
          );
        }
      } else {
        await db
          .update(prospectsTable)
          .set({ followupPaused: true })
          .where(eq(prospectsTable.id, row.prospectId));

        const cancelled = await cancelActiveFollowupsForProspects(
          [row.prospectId],
          "Paused because the user sent a custom outbound message in the thread.",
        );

        customOutbounds++;
        logger.info(
          {
            followupId: row.followupId,
            prospectId: row.prospectId,
            stage: row.stage,
            gmailMessageId: detection.messageId,
            cancelled,
          },
          "Paused draft campaign after custom user outbound message",
        );
      }
    } catch (err) {
      logger.error(
        { err, followupId: row.followupId, prospectId: row.prospectId, userId: user.id },
        "Draft-mode manual-send detection failed",
      );
    }
  }

  return { draftsSent, customOutbounds };
}


async function syncForUser(user: {
  id: number;
  email: string;
  name: string;
  googleRefreshToken: string;
  doctrineLabel: string;
  // Phase 7b: Gmail label that scopes ingest into the Context Based flow.
  contextLabel: string;
  // B9b.3: AntiGhosting label, plumbed in for auto-creation.
  // Not used for ingest — AntiGhosting is operator-driven via
  // the dashboard Mark flow, not label-scan-driven.
  antiGhostingLabel: string;
}): Promise<{ synced: number; repliesDetected: number }> {
  const creds: GmailCredentials = {
    refreshToken: user.googleRefreshToken,
    email: user.email,
    name: user.name,
  };
  const gmail = getGmailForUser(creds);

  const doctrineLabels = user.doctrineLabel.split(",").map((l) => l.trim()).filter(Boolean);
  // Phase 7b: parallel ingest path for context-labeled threads. Each
  // discovered thread is tagged with prospects.app='context' so the
  // dispatcher routes it to the context generator instead of the
  // doctrine pipeline.
  const contextLabels = (user.contextLabel || "").split(",").map((l) => l.trim()).filter(Boolean);
  // B9b.3: include AntiGhosting label(s) so ensureLabelsExist creates
  // them in the operator's mailbox if missing. The label is used by
  // the Mark flow (operator tags a thread in Gmail, then clicks Mark
  // in the dashboard); auto-creation removes the manual setup step.
  const antiGhostingLabels = (user.antiGhostingLabel || "").split(",").map((l) => l.trim()).filter(Boolean);
  const allLabels = [...doctrineLabels, ...contextLabels, ...antiGhostingLabels];

  await ensureLabelsExist(allLabels, gmail);

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const afterDate = sixtyDaysAgo.toISOString().split("T")[0].replace(/-/g, "/");

  // Fetch doctrine and context label sets independently so we know which
  // bucket each message belongs to. Doctrine messages may share threads
  // with context messages; the per-message label list is what disambiguates.
  logger.info({ doctrineLabels, contextLabels, afterDate, userId: user.id, email: user.email }, "Syncing emails for user");
  const doctrineMessages = doctrineLabels.length > 0
    ? await fetchLabeledSentEmails(doctrineLabels, afterDate, gmail)
    : [];
  const contextMessages = contextLabels.length > 0
    ? await fetchLabeledSentEmails(contextLabels, afterDate, gmail)
    : [];

  // Tag each message with its app bucket. If a message somehow appears
  // in both label sets (user labeled the same thread with both labels),
  // doctrine wins — the doctrine flow is the original product.
  const taggedMessages: Array<{ msg: typeof doctrineMessages[number]; app: "doctrine" | "context" }> = [];
  const seenIds = new Set<string>();
  for (const m of doctrineMessages) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    taggedMessages.push({ msg: m, app: "doctrine" });
  }
  for (const m of contextMessages) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    taggedMessages.push({ msg: m, app: "context" });
  }

  logger.info(
    { doctrine: doctrineMessages.length, context: contextMessages.length, total: taggedMessages.length, userId: user.id },
    "Found labeled sent emails (split by app)",
  );

  let synced = 0;
  let conflicts = 0;
  let skipped = 0;
  for (const { msg, app } of taggedMessages) {
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
        // Phase 7b: per-row app + corresponding label.
        batchLabel: app === "context" ? user.contextLabel : user.doctrineLabel,
        app,
        sentAt: new Date(msg.date),
      })
      // B10.1: composite target matches uq_prospects_user_message_app (B9b.6).
      .onConflictDoNothing({ target: [prospectsTable.userId, prospectsTable.gmailMessageId, prospectsTable.app] });
    if (insertResult.rowCount && insertResult.rowCount > 0) synced++;
    else conflicts++;
  }

  const draftDetection = await reconcileDraftedFollowupsForUser(user, gmail);

  const unreplied = await db
    .selectDistinct({ gmailThreadId: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .where(
      and(
        eq(prospectsTable.replied, 0),
        eq(prospectsTable.userId, user.id),
        // Keep scanning paused-but-not-bounced threads so a reply that
        // arrives after a manual or admin pause is still caught. Skip only
        // rows already classified as bounced (a dead address never replies,
        // and re-running classification on it every sync wastes Gmail calls)
        // and archived rows.
        or(ne(prospectsTable.pauseReason, "bounced"), isNull(prospectsTable.pauseReason)),
        eq(prospectsTable.archived, false),
      ),
    );

  let repliesDetected = 0;
  let bouncesDetected = 0;
  for (const row of unreplied) {
    try {
      const verdict = await classifyThreadInbound(row.gmailThreadId, user.email, gmail);
      if (verdict.kind === "none") continue;

      const threadProspects = await db
        .select({ id: prospectsTable.id })
        .from(prospectsTable)
        .where(
          and(
            eq(prospectsTable.gmailThreadId, row.gmailThreadId),
            eq(prospectsTable.userId, user.id),
            eq(prospectsTable.replied, 0),
          ),
        );
      const threadProspectIds = threadProspects.map((p) => p.id);

      if (verdict.kind === "bounce") {
        // Delivery failed. Pause as 'bounced' and keep replied=0 so the
        // address never counts as an engaged prospect. Record the bounce
        // class for the dashboard and the weekly digest. The guard skips
        // rows already marked bounced so a re-seen NDR is a no-op.
        await db
          .update(prospectsTable)
          .set({
            followupPaused: true,
            pauseReason: "bounced",
            bounceType: verdict.bounceType ?? "hard",
            pausedAt: new Date(),
          })
          .where(
            and(
              eq(prospectsTable.gmailThreadId, row.gmailThreadId),
              eq(prospectsTable.userId, user.id),
              eq(prospectsTable.replied, 0),
              or(ne(prospectsTable.pauseReason, "bounced"), isNull(prospectsTable.pauseReason)),
            ),
          );

        await cancelActiveFollowupsForProspects(
          threadProspectIds,
          `Delivery failed (${verdict.bounceType ?? "bounce"}); follow-up cancelled.`,
        );

        bouncesDetected++;
        logger.info(
          { threadId: row.gmailThreadId, userId: user.id, bounceType: verdict.bounceType, detail: verdict.bounceDetail },
          "Bounce detected — campaign auto-paused",
        );
        continue;
      }

      // Genuine reply (or out-of-office). Existing behaviour: mark replied,
      // pause, cancel. Stamp pause_reason + paused_at for consistency.
      await db
        .update(prospectsTable)
        .set({ replied: 1, repliedAt: new Date(), followupPaused: true, pauseReason: "client_reply", pausedAt: new Date() })
        .where(
          and(
            eq(prospectsTable.gmailThreadId, row.gmailThreadId),
            eq(prospectsTable.userId, user.id),
            eq(prospectsTable.replied, 0),
          ),
        );

      await cancelActiveFollowupsForProspects(
        threadProspectIds,
        "Prospect replied; active follow-up cancelled.",
      );

      repliesDetected++;
    } catch (err) {
      logger.error(
        { err, threadId: row.gmailThreadId, userId: user.id },
        "Inbound classification failed for thread",
      );
    }
  }

  // B9b.4: AntiGhosting auto-ingest pass. Threads tagged with
  // the user's AntiGhosting label become anti_ghosting prospects.
  // Errors don't fail the whole sync — doctrine/context above
  // is already done and shouldn't be invalidated by a labeling
  // flow problem. Counts roll into the synced total.
  let antiGhostingIngested = 0;
  try {
    const antiGhostResult = await ingestAntiGhostingLabeledThreads({
      userId: user.id,
      gmail,
      userEmail: user.email,
      antiGhostingLabel: user.antiGhostingLabel,
    });
    antiGhostingIngested = antiGhostResult.ingested;
  } catch (err) {
    logger.error({ err, userId: user.id }, "AntiGhosting ingest pass threw — continuing sync");
  }

  logger.info(
    {
      synced: synced + antiGhostingIngested,
      skipped,
      conflicts,
      repliesDetected,
      bouncesDetected,
      draftsSent: draftDetection.draftsSent,
      customOutbounds: draftDetection.customOutbounds,
      antiGhostingIngested,
      userId: user.id,
    },
    "Sync complete for user",
  );
  return { synced: synced + antiGhostingIngested, repliesDetected };
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
    // Phase 7b: forward the user's context label into syncForUser.
    contextLabel: user.contextLabel,
    // B9b.3: forward antiGhostingLabel so the label gets auto-created.
    antiGhostingLabel: user.antiGhostingLabel,
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
        // Phase 7b: forward the user's context label into syncForUser (loop).
        contextLabel: user.contextLabel,
        // B9b.3: forward antiGhostingLabel so the label gets auto-created.
        antiGhostingLabel: user.antiGhostingLabel,
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
      // B10.1: composite target matches uq_prospects_user_message_app (B9b.6).
      .onConflictDoNothing({ target: [prospectsTable.userId, prospectsTable.gmailMessageId, prospectsTable.app] });
    if (insertResult.rowCount && insertResult.rowCount > 0) synced++;
  }

  const unreplied = await db
    .selectDistinct({ gmailThreadId: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .where(
      and(
        eq(prospectsTable.replied, 0),
        isNull(prospectsTable.userId),
        or(ne(prospectsTable.pauseReason, "bounced"), isNull(prospectsTable.pauseReason)),
        eq(prospectsTable.archived, false),
      ),
    );

  let repliesDetected = 0;
  let bouncesDetected = 0;
  for (const row of unreplied) {
    try {
      const verdict = await classifyThreadInbound(row.gmailThreadId, senderEmail, gmail);
      if (verdict.kind === "none") continue;

      if (verdict.kind === "bounce") {
        await db
          .update(prospectsTable)
          .set({
            followupPaused: true,
            pauseReason: "bounced",
            bounceType: verdict.bounceType ?? "hard",
            pausedAt: new Date(),
          })
          .where(
            and(
              eq(prospectsTable.gmailThreadId, row.gmailThreadId),
              isNull(prospectsTable.userId),
              eq(prospectsTable.replied, 0),
              or(ne(prospectsTable.pauseReason, "bounced"), isNull(prospectsTable.pauseReason)),
            ),
          );

        await db
          .update(followupsTable)
          .set({ status: "cancelled" })
          .where(
            and(
              sql`${followupsTable.prospectId} IN (SELECT id FROM prospects WHERE gmail_thread_id = ${row.gmailThreadId} AND user_id IS NULL)`,
              inArray(followupsTable.status, ["queued", "generating", "pending_approval", "drafted"]),
            ),
          );

        bouncesDetected++;
        logger.info(
          { threadId: row.gmailThreadId, bounceType: verdict.bounceType, detail: verdict.bounceDetail },
          "Bounce detected (legacy) — campaign auto-paused",
        );
        continue;
      }

      await db
        .update(prospectsTable)
        .set({ replied: 1, repliedAt: new Date(), followupPaused: true, pauseReason: "client_reply", pausedAt: new Date() })
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
            inArray(followupsTable.status, ["queued", "generating", "pending_approval", "drafted"]),
          ),
        );

      repliesDetected++;
    } catch (err) {
      logger.error(
        { err, threadId: row.gmailThreadId },
        "Inbound classification failed for thread",
      );
    }
  }

  logger.info({ synced, skipped, repliesDetected, bouncesDetected }, "Sync complete (legacy)");
  return { synced, repliesDetected };
}
