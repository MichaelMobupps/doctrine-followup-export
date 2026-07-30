import { Router, type Request, type Response, type NextFunction } from "express";
import { google, gmail_v1 } from "googleapis";
import { db, prospectsTable, usersTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { getGmailForUser, isOutboundMessage } from "../services/gmailClient";
import { inferVertical } from "../lib/verticalClassifier";
import { logger } from "../lib/logger";

const router = Router();

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  const expected = process.env.ADDON_API_KEY;
  if (!expected) { res.status(500).json({ error: "Server misconfigured: ADDON_API_KEY not set" }); return; }
  if (!key || key !== expected) { res.status(401).json({ error: "Invalid API key" }); return; }
  next();
}

router.use(authMiddleware);

function getLegacyGmail(): gmail_v1.Gmail {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

async function getGmailForRequest(req: Request): Promise<{ gmail: gmail_v1.Gmail; senderEmail: string }> {
  const userId = req.query.userId ? parseInt(req.query.userId as string) : null;

  if (userId) {
    const users = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (users.length > 0 && users[0].googleRefreshToken && users[0].isConnected) {
      return {
        gmail: getGmailForUser({ refreshToken: users[0].googleRefreshToken, email: users[0].email }),
        senderEmail: users[0].email.toLowerCase(),
      };
    }
  }

  return {
    gmail: getLegacyGmail(),
    senderEmail: (process.env.SENDER_EMAIL || "").toLowerCase(),
  };
}


function extractEmail(headerValue: string): string {
  const match = headerValue.match(/<([^>]+)>/) || headerValue.match(/([^\s,]+@[^\s,]+)/);
  return match ? match[1].trim() : headerValue.trim();
}

function extractName(headerValue: string): string {
  const match = headerValue.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  const email = extractEmail(headerValue);
  return email.split("@")[0].replace(/[._-]/g, " ");
}

function isWithinSyncWindow(timestamp: number): boolean {
  const sixtyDaysAgo = new Date();
  sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
  return timestamp >= sixtyDaysAgo.getTime();
}

router.get("/gmail/sent-emails", async (req: Request, res: Response) => {
  try {
    const { gmail, senderEmail } = await getGmailForRequest(req);
    const maxResults = Math.min(parseInt(req.query.limit as string) || 30, 50);

    // B7w: resolve the doctrine label set from the requesting user's row
    // when a userId is supplied, so the inspector's "LABEL" pill exactly
    // mirrors what gmailSync would pick up for that user. The env-var
    // fallback (process.env.DOCTRINE_LABELS) kept legacy behavior but
    // could diverge from the per-user label setting, causing LABEL=red
    // for emails sync would actually ingest, or LABEL=green for emails
    // it would skip.
    let doctrineLabels: string[] = [];
    let contextLabels: string[] = [];
    const userIdParam = req.query.userId ? parseInt(req.query.userId as string) : null;
    if (userIdParam) {
      const users = await db.select({
        doctrineLabel: usersTable.doctrineLabel,
        contextLabel: usersTable.contextLabel,
      }).from(usersTable).where(eq(usersTable.id, userIdParam)).limit(1);
      if (users.length > 0) {
        doctrineLabels = (users[0].doctrineLabel || "").split(",").map(l => l.trim()).filter(Boolean);
        contextLabels = (users[0].contextLabel || "").split(",").map(l => l.trim()).filter(Boolean);
      }
    }
    if (doctrineLabels.length === 0) {
      doctrineLabels = (process.env.DOCTRINE_LABELS || "doctrine").split(",").map(l => l.trim()).filter(Boolean);
    }

    const allLabelsRes = await gmail.users.labels.list({ userId: "me" });
    const allLabels = allLabelsRes.data.labels || [];
    const labelNameMap: Record<string, string> = {};
    const doctrineLabelIds: string[] = [];
    const contextLabelIds: string[] = [];
    for (const label of allLabels) {
      if (label.id && label.name) {
        labelNameMap[label.id] = label.name;
        const nameLower = label.name.toLowerCase();
        if (doctrineLabels.some(dl => nameLower === dl.toLowerCase() || nameLower.startsWith(dl.toLowerCase() + "/"))) {
          doctrineLabelIds.push(label.id);
        }
        if (contextLabels.some(cl => nameLower === cl.toLowerCase() || nameLower.startsWith(cl.toLowerCase() + "/"))) {
          contextLabelIds.push(label.id);
        }
      }
    }

    let q = "in:sent";
    if (req.query.search) {
      q += ` ${req.query.search}`;
    }

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults,
    });

    const items = listRes.data.messages || [];
    const emails: any[] = [];

    for (const item of items) {
      if (!item.id) continue;
      try {
        const msgRes = await gmail.users.messages.get({
          userId: "me",
          id: item.id,
          format: "full",
        });

        const msg = msgRes.data;
        if (!msg.id || !msg.threadId) continue;

        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

        let body = "";
        const parts = msg.payload?.parts || [];
        if (msg.payload?.mimeType === "text/plain" && msg.payload?.body?.data) {
          body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
        } else {
          for (const part of parts) {
            if (part.mimeType === "text/plain" && part.body?.data) {
              body = Buffer.from(part.body.data, "base64").toString("utf-8");
              break;
            }
          }
        }
        if (!body) {
          let htmlBody = "";
          if (msg.payload?.mimeType === "text/html" && msg.payload?.body?.data) {
            htmlBody = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
          } else {
            for (const part of parts) {
              if (part.mimeType === "text/html" && part.body?.data) {
                htmlBody = Buffer.from(part.body.data, "base64").toString("utf-8");
                break;
              }
            }
          }
          if (htmlBody) {
            body = htmlBody
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
              .replace(/<br\s*\/?>/gi, "\n")
              .replace(/<\/p>/gi, "\n")
              .replace(/<\/div>/gi, "\n")
              .replace(/<[^>]+>/g, "")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\n{3,}/g, "\n\n")
              .trim();
          }
        }

        const labelIds = msg.labelIds || [];
        const labelNames = labelIds.map(id => labelNameMap[id] || id);
        const hasDoctrineLabel = labelIds.some(id => doctrineLabelIds.includes(id));
        // B7w: also surface whether the message carries the user's context
        // label. Sync ingests context-labeled messages as app='context';
        // before this fix the inspector ignored that path entirely so the
        // UI's "Missing doctrine label" message was misleading for emails
        // sync would actually pick up via the context route.
        const hasContextLabel = labelIds.some(id => contextLabelIds.includes(id));
        const matchedDoctrineLabels = labelIds
          .filter(id => doctrineLabelIds.includes(id))
          .map(id => labelNameMap[id] || id);
        const matchedContextLabels = labelIds
          .filter(id => contextLabelIds.includes(id))
          .map(id => labelNameMap[id] || id);

        const to = getHeader("To");
        const subject = getHeader("Subject");
        const from = getHeader("From");
        const date = getHeader("Date");
        const recipientEmail = extractEmail(to);
        const recipientName = extractName(to);
        const { vertical, subVertical, reason: verticalReason } = inferVertical(labelNames, subject, body);
        const timestamp = parseInt(msg.internalDate || "0");

        // 2026-07-29 direction-hardening: same SENT-label-aware check the
        // sync pipeline uses, so the inspector's diagnosis matches what
        // sync will actually do (alias sends, display-name spoofs).
        const isSentByMe = isOutboundMessage(msg, senderEmail);
        const withinSyncWindow = isWithinSyncWindow(timestamp);

        // B7w: sync picks up emails with EITHER the doctrine OR the context
        // label (the latter produces app='context' prospects). Treat both
        // as "would be picked up" so the inspector's DETECTED stat and the
        // PENDING SYNC affordance match sync's actual behaviour.
        const hasIngestLabel = hasDoctrineLabel || hasContextLabel;
        const wouldBePickedUp = hasIngestLabel && isSentByMe && withinSyncWindow;

        const reasons: string[] = [];
        if (!isSentByMe) reasons.push("Not sent by configured sender email");
        if (!hasIngestLabel) reasons.push("Missing doctrine or context label");
        if (!withinSyncWindow) reasons.push("Outside 60-day sync window");

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          from,
          to,
          recipientEmail,
          recipientName,
          subject,
          snippet: msg.snippet || "",
          bodyPreview: body.slice(0, 800).trim(),
          date,
          timestamp,
          labelIds,
          labelNames,
          hasDoctrineLabel,
          hasContextLabel,
          matchedDoctrineLabels,
          matchedContextLabels,
          isSentByMe,
          detection: {
            wouldBePickedUp,
            whyNot: wouldBePickedUp ? [] : reasons,
            vertical,
            subVertical,
            verticalReason,
            withinSyncWindow,
            company: recipientEmail ? (recipientEmail.split("@")[1]?.split(".")[0] || "") : "",
          },
        });
      } catch (err) {
        logger.error({ err, messageId: item.id }, "Failed to fetch message for inspector");
      }
    }

    const messageIds = emails.map(e => e.id);
    const threadIds = [...new Set(emails.map(e => e.threadId).filter(Boolean))];
    let dbByMessageId: Record<string, any> = {};
    let dbByThreadId: Record<string, any> = {};
    // B7w: also surface the prospect's `app` so the UI can show whether
    // a synced row is in the doctrine or context pipeline. Without this
    // the user sees DB-green but cannot tell which pipeline page to look
    // at.
    if (messageIds.length > 0) {
      const rows = await db
        .select({
          gmailMessageId: prospectsTable.gmailMessageId,
          gmailThreadId: prospectsTable.gmailThreadId,
          id: prospectsTable.id,
          replied: prospectsTable.replied,
          vertical: prospectsTable.vertical,
          app: prospectsTable.app,
        })
        .from(prospectsTable)
        .where(inArray(prospectsTable.gmailMessageId, messageIds));

      for (const row of rows) {
        dbByMessageId[row.gmailMessageId] = row;
      }
    }
    if (threadIds.length > 0) {
      const threadRows = await db
        .select({
          gmailMessageId: prospectsTable.gmailMessageId,
          gmailThreadId: prospectsTable.gmailThreadId,
          id: prospectsTable.id,
          replied: prospectsTable.replied,
          vertical: prospectsTable.vertical,
          app: prospectsTable.app,
        })
        .from(prospectsTable)
        .where(inArray(prospectsTable.gmailThreadId, threadIds));

      for (const row of threadRows) {
        if (!dbByThreadId[row.gmailThreadId]) {
          dbByThreadId[row.gmailThreadId] = row;
        }
      }
    }

    const enrichedEmails = emails.map(e => {
      const directMatch = dbByMessageId[e.id];
      const threadMatch = dbByThreadId[e.threadId];
      const dbRecord = directMatch || threadMatch;
      const matchType = directMatch ? "message" : threadMatch ? "thread" : null;
      // B7w: split the boolean. `inDatabase` stays as the OR for any
      // client that hasn't upgraded; the new fields let the UI tell the
      // user whether THIS message is ingested (`inDatabaseByMessage`) vs
      // whether some sibling in the thread is (`inDatabaseByThread`).
      // The old conflated field is what hid the Korean-email pending-sync
      // banner: the new email had a thread sibling already in DB, so
      // `inDatabase` was true and the "Sync Now" CTA was suppressed.
      return {
        ...e,
        inDatabase: !!dbRecord,
        inDatabaseByMessage: !!directMatch,
        inDatabaseByThread: !!threadMatch && !directMatch,
        ...(dbRecord ? { dbRecord: { ...dbRecord, matchType } } : {}),
      };
    });

    res.json({
      emails: enrichedEmails,
      meta: {
        total: enrichedEmails.length,
        withDoctrineLabel: enrichedEmails.filter(e => e.hasDoctrineLabel).length,
        withContextLabel: enrichedEmails.filter((e: any) => e.hasContextLabel).length,
        // Direct-only count; the old field stays for back-compat but is
        // intentionally NOT the headline number anymore.
        inDatabase: enrichedEmails.filter(e => e.inDatabaseByMessage).length,
        inDatabaseByMessage: enrichedEmails.filter(e => e.inDatabaseByMessage).length,
        inDatabaseByThread: enrichedEmails.filter(e => e.inDatabaseByThread).length,
        inDatabaseAny: enrichedEmails.filter(e => e.inDatabase).length,
        wouldBePickedUp: enrichedEmails.filter(e => e.detection.wouldBePickedUp).length,
        // pendingSync counts emails that sync would ingest but whose own
        // gmailMessageId is not yet in prospects. Thread-sibling hits do
        // not count — the inspector's old logic did, which hid the CTA.
        pendingSync: enrichedEmails.filter(e => e.detection.wouldBePickedUp && !e.inDatabaseByMessage).length,
        doctrineLabelIds,
        doctrineLabels,
        contextLabelIds,
        contextLabels,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Email inspector error");
    res.status(500).json({ error: msg });
  }
});

router.get("/gmail/thread/:threadId", async (req: Request, res: Response) => {
  try {
    const { gmail, senderEmail } = await getGmailForRequest(req);
    const threadId = (req.params.threadId as string);

    const allLabelsRes = await gmail.users.labels.list({ userId: "me" });
    const allLabels = allLabelsRes.data.labels || [];
    const labelNameMap: Record<string, string> = {};
    for (const label of allLabels) {
      if (label.id && label.name) labelNameMap[label.id] = label.name;
    }

    const threadRes = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });

    const messages = threadRes.data.messages || [];

    const threadMessages = messages.map(msg => {
      const headers = msg.payload?.headers || [];
      const getHeader = (name: string) =>
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

      let body = "";
      const parts = msg.payload?.parts || [];
      if (msg.payload?.mimeType === "text/plain" && msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
      } else {
        for (const part of parts) {
          if (part.mimeType === "text/plain" && part.body?.data) {
            body = Buffer.from(part.body.data, "base64").toString("utf-8");
            break;
          }
        }
      }

      const from = getHeader("From");
      // 2026-07-29 direction-hardening — see isSentByMe above.
      const isFromMe = isOutboundMessage(msg, senderEmail);
      const labelNames = (msg.labelIds || []).map(id => labelNameMap[id] || id);

      return {
        id: msg.id,
        from,
        to: getHeader("To"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        timestamp: parseInt(msg.internalDate || "0"),
        body: body.trim(),
        snippet: msg.snippet || "",
        isFromMe,
        labelNames,
      };
    });

    const hasExternalReply = threadMessages.some(m => !m.isFromMe);

    res.json({
      threadId,
      messageCount: threadMessages.length,
      hasExternalReply,
      messages: threadMessages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, "Thread fetch error");
    res.status(500).json({ error: msg });
  }
});

export default router;
