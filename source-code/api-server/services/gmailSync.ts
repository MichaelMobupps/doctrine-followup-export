import { db, prospectsTable, usersTable, followupsTable } from "@workspace/db";
import { eq, ne, and, or, sql, isNull, inArray, notInArray } from "drizzle-orm";
import {
  fetchLabeledSentEmails,
  classifyThreadInbound,
  extractEmail,
  extractName,
  extractRecipientFirstNameFromBody,
  getGmailForUser,
  ensureLabelsExist,
  detectManualFollowupSend,
  safeSentAt,
} from "./gmailClient";
import type { GmailCredentials } from "./gmailClient";
import { inferVertical } from "../lib/verticalClassifier";
import { summarizeOriginalEmail } from "./emailSummarizer";
import { logger } from "../lib/logger";
import { suppressAddress } from "../lib/suppression";
// B9b.4: AntiGhosting auto-ingest orchestrator. Lists labeled
// threads and ingests each unmarked one via the shared service.
import { ingestAntiGhostingLabeledThreads } from "./antiGhostingIngest";
import { cancelActiveFollowupsForProspects, queueNextFollowupStageForProspect } from "./scheduler";
import { classifyReplySentiment } from "./replySentiment";
import { cascadeCompanyPauseOnPositiveReply } from "./companyCascade";
import { CASCADE_MIN_CONFIDENCE, CASCADE_ELIGIBLE_APPS } from "../lib/replyClassification";

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


// Shape of the users row that sync needs. Shared by both phases.
type SyncUserRow = {
  id: number;
  email: string;
  name: string;
  googleRefreshToken: string;
  doctrineLabel: string;
  // Phase 7b: Gmail label that scopes ingest into the Context Based flow.
  contextLabel: string;
  // B9b.3: AntiGhosting label, plumbed in for auto-creation.
  // Not used for label-scan ingest of NEW threads — AntiGhosting is
  // operator-driven via the dashboard Mark flow.
  antiGhostingLabel: string;
};

/**
 * Phase A of a user's sync: ingest labeled sent emails as prospects.
 *
 * Split out of the old monolithic syncForUser so syncEmails() can run
 * ingest for ALL users before any of the slow reply-scanning starts.
 * Previously one full pass (ingest + reply scan per user, sequentially)
 * took hours in production, and users late in the iteration never got
 * their labeled emails ingested before the process was recycled.
 */
async function ingestForUser(
  user: SyncUserRow,
  gmail: ReturnType<typeof getGmailForUser>,
): Promise<{ synced: number; failed: number }> {
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

  if (doctrineLabels.length === 0 && contextLabels.length === 0) {
    // An empty label config silently ingests nothing forever. Say so loudly
    // instead of logging a healthy-looking "Sync complete" with synced=0.
    logger.warn({ userId: user.id, email: user.email }, "User has no doctrine/context labels configured — ingest skipped");
  }

  await ensureLabelsExist(allLabels, gmail);

  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  const afterDate = sixtyDaysAgo.toISOString().split("T")[0].replace(/-/g, "/");

  // One snapshot of every already-ingested Gmail message ID. Passing this
  // to fetchLabeledSentEmails skips the format:"full" re-download of every
  // known message — the single biggest cost of the old sync (thousands of
  // Gmail calls per tick re-fetching immutable, already-ingested bodies).
  // Unscoped by user on purpose: it mirrors the pre-existing per-message
  // dedup check below, which was also unscoped (legacy user_id IS NULL rows
  // may belong to this same mailbox from the pre-multiuser era).
  //
  // 2026-07-29: SCOPED BY APP — anti_ghosting rows are excluded. The schema
  // deliberately allows the same message to anchor BOTH an anti_ghosting
  // prospect (as its seed) and a doctrine/context prospect
  // (uq_prospects_user_message_app). With the unscoped snapshot, a message
  // first consumed as an AG seed was skipped here forever, so adding the
  // Doctrine label to it later silently never ingested it into the
  // doctrine pipeline.
  const knownRows = await db
    .select({ id: prospectsTable.gmailMessageId })
    .from(prospectsTable)
    .where(ne(prospectsTable.app, "anti_ghosting"));
  const knownIds = new Set(knownRows.map((r) => r.id));

  // 2026-07-29: reciprocal of AntiGhosting's Validator 3. AG refuses to
  // ingest a thread with an active doctrine/context campaign; with the
  // app-scoped dedup above, the reverse hole opened — dual-labeling an
  // AG-seeded thread with the Doctrine label would start a SECOND automated
  // sequence on the same ghosted prospect. Skip (loudly) any message whose
  // thread has an AG prospect with a follow-up still in flight for this
  // user. Once the AG cycle completes/cancels, the label picks it up again.
  const activeAgThreadRows = await db
    .select({ gmailThreadId: prospectsTable.gmailThreadId })
    .from(prospectsTable)
    .innerJoin(followupsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(
      eq(prospectsTable.userId, user.id),
      eq(prospectsTable.app, "anti_ghosting"),
      notInArray(followupsTable.status, ["sent", "cancelled", "failed"]),
    ));
  const activeAgThreads = new Set(
    activeAgThreadRows.map((r) => r.gmailThreadId).filter(Boolean),
  );

  // Fetch doctrine and context label sets independently so we know which
  // bucket each message belongs to. Doctrine messages may share threads
  // with context messages; the per-message label list is what disambiguates.
  logger.info({ doctrineLabels, contextLabels, afterDate, userId: user.id, email: user.email }, "Syncing emails for user");
  const doctrineFetch = doctrineLabels.length > 0
    ? await fetchLabeledSentEmails(doctrineLabels, afterDate, gmail, knownIds)
    : { messages: [], skippedKnown: 0 };
  const contextFetch = contextLabels.length > 0
    ? await fetchLabeledSentEmails(contextLabels, afterDate, gmail, knownIds)
    : { messages: [], skippedKnown: 0 };
  const doctrineMessages = doctrineFetch.messages;
  const contextMessages = contextFetch.messages;

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
    {
      doctrine: doctrineMessages.length,
      context: contextMessages.length,
      total: taggedMessages.length,
      skippedKnown: doctrineFetch.skippedKnown + contextFetch.skippedKnown,
      userId: user.id,
    },
    "Found labeled sent emails (split by app)",
  );

  let synced = 0;
  let conflicts = 0;
  let skipped = 0;
  // Count of messages whose ingest threw (per-message isolation below).
  // Returned to the caller and surfaced in the cron heartbeat: a mailbox
  // where EVERY message fails (dead summarizer key, DB regression) must
  // not masquerade as a healthy "synced: 0".
  let failed = 0;
  for (const { msg, app } of taggedMessages) {
    // Per-message isolation: a single poison message (malformed headers,
    // transient DB error, anything) must never abort the rest of the
    // user's ingest. Before this guard, one throwing message killed the
    // whole user's sync on every tick — silently, forever.
    try {
      // 2026-07-29: active-AG-campaign guard (see activeAgThreads above).
      if (msg.threadId && activeAgThreads.has(msg.threadId)) {
        skipped++;
        logger.warn(
          { messageId: msg.id, threadId: msg.threadId, app, userId: user.id },
          "Skipping doctrine/context ingest — thread has an active AntiGhosting campaign (would double-send). Remove one of the labels, or wait for the AG cycle to finish.",
        );
        continue;
      }

      // Skip messages we've already ingested. knownIds above prefilters the
      // bulk; this per-message check additionally catches rows inserted by
      // a concurrent pass after the snapshot, so the LLM summarizer below
      // never re-runs for a message some other pass just ingested.
      // 2026-07-29: scoped to doctrine/context (see knownRows above) — an
      // anti_ghosting seed row must not block doctrine/context ingest of
      // the same message.
      const existing = await db
        .select({ id: prospectsTable.id })
        .from(prospectsTable)
        .where(and(
          eq(prospectsTable.gmailMessageId, msg.id),
          ne(prospectsTable.app, "anti_ghosting"),
        ))
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
          sentAt: safeSentAt(msg),
        })
        // B10.1: composite target matches uq_prospects_user_message_app (B9b.6).
        .onConflictDoNothing({ target: [prospectsTable.userId, prospectsTable.gmailMessageId, prospectsTable.app] });
      if (insertResult.rowCount && insertResult.rowCount > 0) synced++;
      else conflicts++;
    } catch (err) {
      failed++;
      logger.error(
        { err, messageId: msg.id, threadId: msg.threadId, app, userId: user.id },
        "Failed to ingest labeled message — continuing with the rest",
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
    { synced, skipped, conflicts, failed, antiGhostingIngested, userId: user.id },
    "Ingest complete for user",
  );
  return { synced: synced + antiGhostingIngested, failed };
}

/**
 * Phase B of a user's sync: reconcile draft-mode sends and scan unreplied
 * threads for inbound replies/bounces/OOOs. This is the slow half (one
 * Gmail thread fetch per unreplied thread, plus LLM sentiment calls), which
 * is why syncEmails() runs it strictly AFTER every user's ingest phase.
 */
async function handleRepliesForUser(
  user: SyncUserRow,
  gmail: ReturnType<typeof getGmailForUser>,
): Promise<{ repliesDetected: number }> {
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
        .select({
          id: prospectsTable.id,
          email: prospectsTable.email,
          sentAt: prospectsTable.sentAt,
          app: prospectsTable.app,
          originalBodySummary: prospectsTable.originalBodySummary,
          replyClass: prospectsTable.replyClass,
          replyClassifiedMsgId: prospectsTable.replyClassifiedMsgId,
        })
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

        // Hard bounce means the address is permanently undeliverable. Add it
        // to the global suppression list so it is never emailed again. Soft
        // bounces are transient and are not suppressed.
        if ((verdict.bounceType ?? "hard") === "hard") {
          for (const p of threadProspects) {
            if (p.email) {
              await suppressAddress(p.email, "hard_bounce", verdict.bounceDetail ?? "hard bounce");
            }
          }
        }

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

      // verdict.kind === "ooo": every non-bounce inbound on the thread is an
      // out-of-office auto-reply. The prospect did not respond. Record the
      // classification for audit and continue follow-ups untouched. No
      // replied flag, no pause. This changes the prior behaviour, which
      // paused on any inbound including OOO.
      if (verdict.kind === "ooo") {
        const prev = threadProspects[0];
        const latestId = verdict.latestInboundMessageId ?? null;
        if (!prev || prev.replyClass !== "ooo" || prev.replyClassifiedMsgId !== latestId) {
          await db
            .update(prospectsTable)
            .set({ replyClass: "ooo", replyClassifiedMsgId: latestId })
            .where(
              and(
                eq(prospectsTable.gmailThreadId, row.gmailThreadId),
                eq(prospectsTable.userId, user.id),
                eq(prospectsTable.replied, 0),
              ),
            );
        }
        logger.info({ threadId: row.gmailThreadId, userId: user.id }, "Out-of-office reply ignored — follow-ups continue");
        continue;
      }

      // verdict.kind === "reply": a genuine human inbound exists. Classify its
      // sentiment to decide whether to cascade to colleagues.
      const trigger = threadProspects[0];
      const latestId = verdict.latestInboundMessageId ?? null;

      // Cost guard: if the LLM already classified this exact inbound as OOO on
      // a previous pass (a regex-missed auto-reply it caught), do not pay for
      // the classifier again while nothing has changed.
      if (trigger && trigger.replyClass === "ooo" && trigger.replyClassifiedMsgId && latestId && trigger.replyClassifiedMsgId === latestId) {
        continue;
      }

      const sentiment = await classifyReplySentiment({
        gmail,
        latestInboundMessageId: latestId,
        outreachTopic: trigger?.originalBodySummary?.slice(0, 300) || undefined,
      });

      // LLM safety net caught an out-of-office the first-pass regex missed.
      // Treat exactly like verdict.kind === "ooo": record and continue.
      if (sentiment.replyClass === "ooo") {
        await db
          .update(prospectsTable)
          .set({ replyClass: "ooo", replyClassifiedMsgId: latestId })
          .where(
            and(
              eq(prospectsTable.gmailThreadId, row.gmailThreadId),
              eq(prospectsTable.userId, user.id),
              eq(prospectsTable.replied, 0),
            ),
          );
        logger.info({ threadId: row.gmailThreadId, userId: user.id }, "LLM classified reply as out-of-office — follow-ups continue");
        continue;
      }

      // A real reply of class positive | negative | unsubscribe | unknown.
      // Existing behaviour for the replier in every case: mark replied, pause,
      // cancel active follow-ups. The cascade to colleagues is gated below.
      await db
        .update(prospectsTable)
        .set({
          replied: 1,
          repliedAt: new Date(),
          followupPaused: true,
          pauseReason: "client_reply",
          pausedAt: new Date(),
          replyClass: sentiment.replyClass,
          replyClassifiedMsgId: latestId,
        })
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

      // Unsubscribe: suppress every address on the thread so it is never
      // emailed again. No cascade.
      if (sentiment.replyClass === "unsubscribe") {
        for (const p of threadProspects) {
          if (p.email) await suppressAddress(p.email, "manual", "unsubscribe reply");
        }
      }

      // Positive reply above the confidence floor, from an eligible cold-
      // outreach product: pause recent sibling campaigns at the same company.
      if (
        sentiment.replyClass === "positive" &&
        sentiment.confidence >= CASCADE_MIN_CONFIDENCE &&
        trigger &&
        (CASCADE_ELIGIBLE_APPS as readonly string[]).includes(trigger.app)
      ) {
        try {
          const cascade = await cascadeCompanyPauseOnPositiveReply({
            userId: user.id,
            replierEmail: trigger.email,
            replierSentAt: trigger.sentAt,
            replierThreadId: row.gmailThreadId,
            triggerProspectId: trigger.id,
          });
          if (cascade.candidateCount > 0) {
            logger.info(
              { threadId: row.gmailThreadId, userId: user.id, domain: cascade.domain, paused: cascade.pausedProspectIds.length },
              "Company-reply cascade paused sibling campaigns",
            );
          }
        } catch (cascadeErr) {
          // A cascade failure must never break reply detection. The replier is
          // already paused; siblings simply get one more follow-up.
          logger.error({ cascadeErr, threadId: row.gmailThreadId, userId: user.id }, "Company-reply cascade failed (reply still handled)");
        }
      }

      repliesDetected++;
    } catch (err) {
      logger.error(
        { err, threadId: row.gmailThreadId, userId: user.id },
        "Inbound classification failed for thread",
      );
    }
  }

  logger.info(
    {
      repliesDetected,
      bouncesDetected,
      draftsSent: draftDetection.draftsSent,
      customOutbounds: draftDetection.customOutbounds,
      userId: user.id,
    },
    "Reply scan complete for user",
  );
  return { repliesDetected };
}

async function syncForUser(user: SyncUserRow): Promise<{ synced: number; repliesDetected: number }> {
  const creds: GmailCredentials = {
    refreshToken: user.googleRefreshToken,
    email: user.email,
    name: user.name,
  };
  const gmail = getGmailForUser(creds);

  const ingest = await ingestForUser(user, gmail);
  const replies = await handleRepliesForUser(user, gmail);
  return { synced: ingest.synced, repliesDetected: replies.repliesDetected };
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

// Per-user outcome of an all-users sync pass. Recorded into the
// sync_and_autoqueue cron heartbeat so a persistently-failing user is
// visible in the DB instead of only in ephemeral stdout logs. (Shama's
// mailbox failed silently for a month exactly because per-user errors
// were swallowed here with nothing but a log line.)
export interface PerUserSyncOutcome {
  userId: number;
  email: string;
  synced: number;
  repliesDetected: number;
  // Messages whose ingest threw and was skipped (per-message isolation).
  // Nonzero here with synced=0 means the mailbox is systematically failing.
  ingestFailed?: number;
  ingestError?: string;
  replyError?: string;
  // True when the failure looks like a dead OAuth token (invalid_grant):
  // the user must reconnect Gmail from the Accounts page.
  authFailure?: boolean;
}

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.message} ${JSON.stringify((err as any).response?.data ?? "")}` : String(err);
  return /invalid_grant|invalid_client|unauthorized_client/i.test(msg);
}

/**
 * Thrown by syncEmails() when an all-users pass is already in flight.
 * Callers treat this as "skip, not failure": the cron tick records a
 * skipped heartbeat; the /sync routes surface a 409.
 */
export class SyncAlreadyRunningError extends Error {
  statusCode = 409;
  constructor(ageMs: number) {
    super(`An all-users sync pass is already running (started ${Math.round(ageMs / 1000)}s ago)`);
    this.name = "SyncAlreadyRunningError";
  }
}

// Overlap guard for ALL-USERS sync passes, whatever the entry point (cron
// tick, POST /api/sync, /api/context/sync, /api/anti-ghosting/sync). In
// production, overlapping multi-hour passes exhausted the DB pool and the
// Gmail quota. Per-user manual syncs (syncEmailsForUser) intentionally stay
// exempt: they are small, CAS-protected, and users expect the button to work
// even while a background pass runs.
//
// Wedge watchdog: if the "running" pass is older than the limit, assume the
// process lost it (hung socket — googleapis has no default request timeout)
// and reclaim the guard rather than blocking sync forever. A healthy pass
// finishes in minutes now that ingest skips known messages.
let runningAllUsersPass: { startedAt: number } | null = null;
const SYNC_WEDGE_LIMIT_MS = 4 * 60 * 60 * 1000;

export async function syncEmails(): Promise<{
  synced: number;
  repliesDetected: number;
  perUser: PerUserSyncOutcome[];
}> {
  if (runningAllUsersPass !== null) {
    const ageMs = Date.now() - runningAllUsersPass.startedAt;
    if (ageMs < SYNC_WEDGE_LIMIT_MS) {
      throw new SyncAlreadyRunningError(ageMs);
    }
    logger.error(
      { ageMs },
      "Previous all-users sync pass exceeded the wedge limit — reclaiming the overlap guard",
    );
  }
  // Identity token per pass: if a wedged old pass eventually completes
  // AFTER we reclaimed the guard, its finally must not clear OUR guard.
  const pass = { startedAt: Date.now() };
  runningAllUsersPass = pass;
  try {
    return await runAllUsersSync();
  } finally {
    if (runningAllUsersPass === pass) runningAllUsersPass = null;
  }
}

async function runAllUsersSync(): Promise<{
  synced: number;
  repliesDetected: number;
  perUser: PerUserSyncOutcome[];
}> {
  const connectedUsers = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.isConnected, true))
    // Stable iteration order. The old unordered SELECT made starvation
    // (when a pass died midway) land on arbitrary users, which is much
    // harder to notice and diagnose than a deterministic order.
    .orderBy(usersTable.id);

  if (connectedUsers.length === 0) {
    const fallbackToken = process.env.GOOGLE_REFRESH_TOKEN;
    const fallbackEmail = process.env.SENDER_EMAIL;
    if (fallbackToken && fallbackEmail) {
      logger.info("No connected users — using legacy env var credentials");
      const legacy = await syncForLegacyUser(fallbackToken, fallbackEmail);
      return { ...legacy, perUser: [] };
    }
    logger.info("No connected users and no legacy credentials — skipping sync");
    return { synced: 0, repliesDetected: 0, perUser: [] };
  }

  const rows: Array<{ user: SyncUserRow; gmail: ReturnType<typeof getGmailForUser>; outcome: PerUserSyncOutcome }> = [];
  for (const user of connectedUsers) {
    if (!user.googleRefreshToken) continue;
    const syncUser: SyncUserRow = {
      id: user.id,
      email: user.email,
      name: user.name,
      googleRefreshToken: user.googleRefreshToken,
      doctrineLabel: user.doctrineLabel,
      // Phase 7b: forward the user's context label into the sync pass.
      contextLabel: user.contextLabel,
      // B9b.3: forward antiGhostingLabel so the label gets auto-created.
      antiGhostingLabel: user.antiGhostingLabel,
    };
    rows.push({
      user: syncUser,
      gmail: getGmailForUser({ refreshToken: syncUser.googleRefreshToken, email: syncUser.email, name: syncUser.name }),
      outcome: { userId: user.id, email: user.email, synced: 0, repliesDetected: 0 },
    });
  }

  // Phase A: ingest labeled emails for EVERY user first. Ingest is cheap
  // (new messages only, thanks to the knownIds prefilter) while the reply
  // scan below is slow (per-thread Gmail fetches + LLM sentiment). Running
  // all ingests first guarantees that no user's new labeled emails wait
  // behind another user's multi-hour reply scan — the exact failure that
  // starved late-iteration users for weeks when passes were killed midway.
  for (const row of rows) {
    try {
      const result = await ingestForUser(row.user, row.gmail);
      row.outcome.synced = result.synced;
      if (result.failed > 0) row.outcome.ingestFailed = result.failed;
    } catch (err) {
      row.outcome.ingestError = err instanceof Error ? err.message : String(err);
      if (isAuthError(err)) row.outcome.authFailure = true;
      logger.error(
        { err, userId: row.user.id, email: row.user.email, authFailure: row.outcome.authFailure },
        "Ingest failed for user",
      );
    }
  }

  // Phase B: draft reconciliation + reply/bounce scanning per user.
  for (const row of rows) {
    try {
      const result = await handleRepliesForUser(row.user, row.gmail);
      row.outcome.repliesDetected = result.repliesDetected;
    } catch (err) {
      row.outcome.replyError = err instanceof Error ? err.message : String(err);
      if (isAuthError(err)) row.outcome.authFailure = true;
      logger.error(
        { err, userId: row.user.id, email: row.user.email, authFailure: row.outcome.authFailure },
        "Reply scan failed for user",
      );
    }
  }

  const perUser = rows.map((r) => r.outcome);
  return {
    synced: perUser.reduce((acc, o) => acc + o.synced, 0),
    repliesDetected: perUser.reduce((acc, o) => acc + o.repliesDetected, 0),
    perUser,
  };
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
  // Same knownIds prefilter as ingestForUser: skip re-downloading full
  // bodies of messages that are already prospects. 2026-07-29: scoped by
  // app for the same reason as ingestForUser (AG seed rows must not block
  // doctrine ingest of the same message).
  const knownRows = await db
    .select({ id: prospectsTable.gmailMessageId })
    .from(prospectsTable)
    .where(ne(prospectsTable.app, "anti_ghosting"));
  const knownIds = new Set(knownRows.map((r) => r.id));
  const { messages, skippedKnown } = await fetchLabeledSentEmails(labels, afterDate, gmail, knownIds);
  logger.info({ count: messages.length, skippedKnown }, "Found labeled sent emails");

  let synced = 0;
  let skipped = 0;
  for (const msg of messages) {
    // Per-message isolation — see matching comment in ingestForUser.
    try {
      // Skip messages we've already ingested. See matching comment in
      // ingestForUser above — this prevents the LLM summarizer from re-running
      // on every email in the 60-day window on every 15-minute sync tick.
      // 2026-07-29: app-scoped like ingestForUser.
      const existing = await db
        .select({ id: prospectsTable.id })
        .from(prospectsTable)
        .where(and(
          eq(prospectsTable.gmailMessageId, msg.id),
          ne(prospectsTable.app, "anti_ghosting"),
        ))
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
          sentAt: safeSentAt(msg),
        })
        // B10.1: composite target matches uq_prospects_user_message_app (B9b.6).
        .onConflictDoNothing({ target: [prospectsTable.userId, prospectsTable.gmailMessageId, prospectsTable.app] });
      if (insertResult.rowCount && insertResult.rowCount > 0) synced++;
    } catch (err) {
      logger.error(
        { err, messageId: msg.id, threadId: msg.threadId },
        "Failed to ingest labeled message (legacy) — continuing with the rest",
      );
    }
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

        // Hard bounce: suppress the recipient address(es) on this thread.
        if ((verdict.bounceType ?? "hard") === "hard") {
          const emails = await db
            .select({ email: prospectsTable.email })
            .from(prospectsTable)
            .where(and(eq(prospectsTable.gmailThreadId, row.gmailThreadId), isNull(prospectsTable.userId)));
          for (const e of emails) {
            if (e.email) await suppressAddress(e.email, "hard_bounce", verdict.bounceDetail ?? "hard bounce");
          }
        }

        bouncesDetected++;
        logger.info(
          { threadId: row.gmailThreadId, bounceType: verdict.bounceType, detail: verdict.bounceDetail },
          "Bounce detected (legacy) — campaign auto-paused",
        );
        continue;
      }

      const legacyThreadProspects = await db
        .select({
          id: prospectsTable.id,
          email: prospectsTable.email,
          sentAt: prospectsTable.sentAt,
          app: prospectsTable.app,
          originalBodySummary: prospectsTable.originalBodySummary,
          replyClass: prospectsTable.replyClass,
          replyClassifiedMsgId: prospectsTable.replyClassifiedMsgId,
        })
        .from(prospectsTable)
        .where(
          and(
            eq(prospectsTable.gmailThreadId, row.gmailThreadId),
            isNull(prospectsTable.userId),
            eq(prospectsTable.replied, 0),
          ),
        );

      // OOO: ignore, follow-ups continue. Behaviour change from the prior
      // pause-on-any-inbound path.
      if (verdict.kind === "ooo") {
        const prev = legacyThreadProspects[0];
        const latestId = verdict.latestInboundMessageId ?? null;
        if (!prev || prev.replyClass !== "ooo" || prev.replyClassifiedMsgId !== latestId) {
          await db
            .update(prospectsTable)
            .set({ replyClass: "ooo", replyClassifiedMsgId: latestId })
            .where(
              and(
                eq(prospectsTable.gmailThreadId, row.gmailThreadId),
                isNull(prospectsTable.userId),
                eq(prospectsTable.replied, 0),
              ),
            );
        }
        logger.info({ threadId: row.gmailThreadId }, "Out-of-office reply ignored (legacy) — follow-ups continue");
        continue;
      }

      const trigger = legacyThreadProspects[0];
      const latestId = verdict.latestInboundMessageId ?? null;

      // Cost guard: skip re-classifying an inbound the LLM already called OOO.
      if (trigger && trigger.replyClass === "ooo" && trigger.replyClassifiedMsgId && latestId && trigger.replyClassifiedMsgId === latestId) {
        continue;
      }

      const sentiment = await classifyReplySentiment({
        gmail,
        latestInboundMessageId: latestId,
        outreachTopic: trigger?.originalBodySummary?.slice(0, 300) || undefined,
      });

      if (sentiment.replyClass === "ooo") {
        await db
          .update(prospectsTable)
          .set({ replyClass: "ooo", replyClassifiedMsgId: latestId })
          .where(
            and(
              eq(prospectsTable.gmailThreadId, row.gmailThreadId),
              isNull(prospectsTable.userId),
              eq(prospectsTable.replied, 0),
            ),
          );
        logger.info({ threadId: row.gmailThreadId }, "LLM classified reply as out-of-office (legacy) — follow-ups continue");
        continue;
      }

      await db
        .update(prospectsTable)
        .set({
          replied: 1,
          repliedAt: new Date(),
          followupPaused: true,
          pauseReason: "client_reply",
          pausedAt: new Date(),
          replyClass: sentiment.replyClass,
          replyClassifiedMsgId: latestId,
        })
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

      if (sentiment.replyClass === "unsubscribe") {
        for (const p of legacyThreadProspects) {
          if (p.email) await suppressAddress(p.email, "manual", "unsubscribe reply");
        }
      }

      if (
        sentiment.replyClass === "positive" &&
        sentiment.confidence >= CASCADE_MIN_CONFIDENCE &&
        trigger &&
        (CASCADE_ELIGIBLE_APPS as readonly string[]).includes(trigger.app)
      ) {
        try {
          const cascade = await cascadeCompanyPauseOnPositiveReply({
            userId: null,
            replierEmail: trigger.email,
            replierSentAt: trigger.sentAt,
            replierThreadId: row.gmailThreadId,
            triggerProspectId: trigger.id,
          });
          if (cascade.candidateCount > 0) {
            logger.info(
              { threadId: row.gmailThreadId, domain: cascade.domain, paused: cascade.pausedProspectIds.length },
              "Company-reply cascade paused sibling campaigns (legacy)",
            );
          }
        } catch (cascadeErr) {
          logger.error({ cascadeErr, threadId: row.gmailThreadId }, "Company-reply cascade failed (legacy; reply still handled)");
        }
      }

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
