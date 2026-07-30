import { google, gmail_v1 } from "googleapis";
import { logger } from "../lib/logger";

export interface GmailMessageMeta {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  date: string;
  labels: string[];
}

export interface GmailCredentials {
  refreshToken: string;
  email: string;
  name?: string;
}

function getAuth() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
}

export function getGmailForUser(creds: GmailCredentials): gmail_v1.Gmail {
  const auth = getAuth();
  auth.setCredentials({ refresh_token: creds.refreshToken });
  return google.gmail({ version: "v1", auth });
}

function getGmail(): gmail_v1.Gmail {
  const auth = getAuth();
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth });
}

export async function ensureLabelsExist(
  labelNames: string[],
  gmail: gmail_v1.Gmail,
): Promise<Map<string, string>> {
  const labelIdToName = new Map<string, string>();
  try {
    const res = await gmail.users.labels.list({ userId: "me" });
    const allLabels = res.data.labels || [];
    const existing = new Set(
      allLabels.map((l) => l.name?.toLowerCase()).filter(Boolean),
    );

    for (const l of allLabels) {
      if (l.id && l.name) {
        labelIdToName.set(l.id, l.name);
      }
    }

    for (const name of labelNames) {
      if (existing.has(name.toLowerCase())) continue;
      try {
        const created = await gmail.users.labels.create({
          userId: "me",
          requestBody: {
            name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        });
        logger.info({ label: name }, "Created missing Gmail label");
        if (created.data.id && created.data.name) {
          labelIdToName.set(created.data.id, created.data.name);
        }
      } catch (err: any) {
        if (err.code === 409) {
          logger.debug({ label: name }, "Label already exists (conflict)");
        } else {
          logger.error({ err, label: name }, "Failed to create Gmail label");
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to list Gmail labels for auto-creation");
  }
  return labelIdToName;
}

export async function fetchLabeledSentEmails(
  labels: string[],
  afterDate?: string,
  gmail?: gmail_v1.Gmail,
): Promise<GmailMessageMeta[]> {
  if (!gmail) gmail = getGmail();

  const labelQuery = labels.map((l) => `label:${l.replace(/\s+/g, "-")}`).join(" OR ");
  let q = `in:sent (${labelQuery})`;
  if (afterDate) {
    q += ` after:${afterDate}`;
  }

  const messages: GmailMessageMeta[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 100,
      pageToken,
    });

    const items = res.data.messages || [];
    for (const item of items) {
      if (!item.id) continue;
      try {
        const msg = await fetchMessageDetail(gmail, item.id);
        if (msg) messages.push(msg);
      } catch (err) {
        logger.error({ err, messageId: item.id }, "Failed to fetch message detail");
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return messages;
}

async function fetchMessageDetail(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<GmailMessageMeta | null> {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const msg = res.data;
  if (!msg.id || !msg.threadId) return null;

  const headers = msg.payload?.headers || [];
  const getHeader = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

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

  const summary = body.slice(0, 500).trim();
  const labelIds = msg.labelIds || [];

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader("From"),
    to: getHeader("To"),
    subject: getHeader("Subject"),
    snippet: msg.snippet || "",
    body: summary,
    date: getHeader("Date"),
    labels: labelIds,
  };
}

export async function checkThreadForReplies(
  threadId: string,
  senderEmail: string,
  gmail?: gmail_v1.Gmail,
): Promise<boolean> {
  if (!gmail) gmail = getGmail();
  const res = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "metadata",
    metadataHeaders: ["From"],
  });

  const messages = res.data.messages || [];
  if (messages.length < 2) return false;

  const senderLower = senderEmail.toLowerCase();

  for (const msg of messages) {
    const from =
      msg.payload?.headers
        ?.find((h) => h.name?.toLowerCase() === "from")
        ?.value?.toLowerCase() || "";
    if (senderLower && !from.includes(senderLower)) {
      return true;
    }
  }

  return false;
}

function mimeEncodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const encoded = Buffer.from(value, "utf-8").toString("base64");
  return `=?UTF-8?B?${encoded}?=`;
}

async function getRfc822MessageId(gmail: gmail_v1.Gmail, messageId: string): Promise<string | null> {
  try {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "Message-Id"],
    });
    const headers = msg.data.payload?.headers || [];
    const messageIdHeader = headers.find(
      (h) => h.name?.toLowerCase() === "message-id"
    );
    return messageIdHeader?.value || null;
  } catch {
    return null;
  }
}

async function getGmailSignatureHtml(gmail: gmail_v1.Gmail, senderEmail: string): Promise<string> {
  try {
    const res = await gmail.users.settings.sendAs.get({
      userId: "me",
      sendAsEmail: senderEmail,
    });
    return res.data.signature || "";
  } catch {
    return "";
  }
}

function plainTextToHtml(text: string): string {
  let result = text;
  result = result.replace(/\\n/g, "\n");
  result = result.replace(/&/g, "&amp;");
  result = result.replace(/</g, "&lt;");
  result = result.replace(/>/g, "&gt;");
  result = result.replace(/\n/g, "<br>");
  return result;
}

export async function sendFollowupReply(params: {
  threadId: string;
  originalMessageId: string;
  to: string;
  subject: string;
  body: string;
  senderName: string;
  senderEmail: string;
  gmail?: gmail_v1.Gmail;
}): Promise<string> {
  const gmail = params.gmail || getGmail();

  const rfc822Id = await getRfc822MessageId(gmail, params.originalMessageId);
  const inReplyTo = rfc822Id || `<${params.originalMessageId}>`;
  const references = rfc822Id || `<${params.originalMessageId}>`;

  const signatureHtml = await getGmailSignatureHtml(gmail, params.senderEmail);
  const bodyHtml = plainTextToHtml(params.body);
  const fontStyle = 'font-family: "Calibri Light", Calibri, sans-serif; font-size: 11pt;';
  const fullHtml = signatureHtml
    ? `<div dir="ltr" style="${fontStyle}">${bodyHtml}<br><br><div class="gmail_signature">${signatureHtml}</div></div>`
    : `<div dir="ltr" style="${fontStyle}">${bodyHtml}</div>`;

  const replySubject = params.subject.startsWith("Re:")
    ? params.subject
    : `Re: ${params.subject}`;

  const encodedSubject = mimeEncodeHeader(replySubject);
  const encodedSenderName = mimeEncodeHeader(params.senderName);

  const rawMessage = [
    `From: ${encodedSenderName} <${params.senderEmail}>`,
    `To: ${params.to}`,
    `Subject: ${encodedSubject}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(fullHtml, "utf-8").toString("base64"),
  ].join("\r\n");

  const encoded = Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encoded,
      threadId: params.threadId,
    },
  });

  return res.data.id || "";
}

export function extractEmail(headerValue: string): string {
  const match =
    headerValue.match(/<([^>]+)>/) || headerValue.match(/([^\s,]+@[^\s,]+)/);
  return match ? match[1].trim() : headerValue.trim();
}

/**
 * Extract a displayable recipient name from a To/From header value.
 *
 * This is a STRICT extractor — it only returns a name when the header clearly
 * contains a human display name (e.g., `"David Cohen" <david@acme.com>`).
 * It refuses to treat email local-parts as names ("hwholestorm" isn't a name),
 * and refuses the pathological case where the "display name" is itself an
 * email address.
 *
 * For cold outreach we prefer extracting the name from the email body greeting
 * (see extractRecipientFirstNameFromBody) — the body is much more reliable.
 * This function is the secondary source.
 *
 * Returns empty string when nothing reliable is available. The caller should
 * then fall through to body parsing, and only fall back to a neutral greeting
 * if both fail.
 */
export function extractName(headerValue: string): string {
  const bracketMatch = headerValue.match(/^"?([^"<]+?)"?\s*</);
  if (!bracketMatch) return "";
  const candidate = bracketMatch[1].trim().replace(/^"+|"+$/g, "");
  if (!candidate) return "";
  // Reject "display name is actually an email" (common when contacts have no
  // real name and the client auto-fills the email as the display name).
  if (candidate.includes("@")) return "";
  // Must contain at least one letter sequence that looks like a word.
  // Letters from: Latin incl. accents, Greek, Cyrillic, Hebrew, Arabic, CJK,
  // Hangul, Hiragana, Katakana, Thai, Devanagari, etc.
  if (!/[A-Za-z\u00C0-\u024F\u0370-\u1CFF\u1D00-\uFFFF]{2}/.test(candidate)) return "";
  // Normalize Latin-script casing only; leave other scripts unchanged.
  if (/^[A-Za-z\s'.-]+$/.test(candidate)) {
    return candidate
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return candidate;
}

/**
 * Extract the recipient's first name from the opening greeting of the original
 * email body. This is the PRIMARY source of recipient names for cold outreach —
 * the sender almost always wrote "Hi Sarah," or "Shalom David," at the top of
 * the email, which is the cleanest ground truth for who the email is addressed to.
 *
 * Supports greetings in many languages. Returns the raw first name (not lowercased,
 * not normalized) or empty string if nothing found in the first few lines.
 */
export function extractRecipientFirstNameFromBody(body: string): string {
  if (!body) return "";

  // Strip HTML tags, collapse whitespace, focus on first ~300 chars.
  const plain = body
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "")
    .trim();
  const head = plain.slice(0, 300);

  // Letter character class covering Latin (incl. accents), Cyrillic, Greek,
  // Hebrew, Arabic, CJK, Hangul, Hiragana, Katakana, Thai, Devanagari, etc.
  const LETTER = "A-Za-z\\u00C0-\\u024F\\u0370-\\u1CFF\\u1D00-\\uFFFF";
  // A "name token" is 2+ letters. Allow hyphens and apostrophes mid-name
  // ("Jean-Luc", "O'Brien"). Allow one optional second name word for CJK
  // constructions where given + surname are separated by a space.
  const NAME = `[${LETTER}][${LETTER}'\\-]{1,}(?:\\s[${LETTER}][${LETTER}'\\-]{1,})?`;

  // Greeting openers across many languages. Order matters: try longest first
  // so "Good morning" wins over "Good".
  const OPENERS = [
    // English
    "Good morning", "Good afternoon", "Good evening",
    "Hi", "Hello", "Hey", "Hiya", "Dear", "Greetings", "Shalom", "Salaam",
    "Salam", "Namaste",
    // Hebrew
    "שלום", "היי", "הי", "בוקר טוב", "ערב טוב",
    // Spanish / Portuguese
    "Hola", "Buenos d[ií]as", "Buenas tardes", "Buenas noches",
    "Ol[aá]", "Bom dia", "Boa tarde", "Boa noite", "Prezado(?:a)?", "Estimado(?:a)?",
    // French
    "Bonjour", "Bonsoir", "Salut", "Cher(?:e)?",
    // German
    "Hallo", "Guten Tag", "Guten Morgen", "Guten Abend", "Sehr geehrte(?:r)?",
    "Liebe(?:r)?",
    // Italian
    "Ciao", "Buongiorno", "Buonasera", "Gentile", "Caro",
    // Dutch
    "Hoi", "Hallo", "Beste", "Geachte",
    // Russian
    "Здравствуйте", "Привет", "Добрый день", "Уважаемый(?:ая)?",
    // Japanese
    "こんにちは", "こんばんは", "おはようございます",
    // Korean
    "안녕하세요",
    // Chinese
    "你好", "您好",
    // Arabic
    "مرحبا", "السلام عليكم", "أهلا",
    // Turkish
    "Merhaba", "Sayın",
    // Thai
    "สวัสดี",
  ];

  const opener = `(?:${OPENERS.join("|")})`;
  // Pattern: opener, optional space, optional honorific, name, then comma/colon/newline/end.
  // The honorific group is loose: "Mr", "Mr.", "Ms", "Mrs", "Dr", "Prof" etc.
  const HONORIFIC = `(?:(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Sra|M|Mme|Herr|Frau|Dott)\\.?\\s+)?`;
  const greetingRegex = new RegExp(
    `^\\s*${opener}[\\s,]*(?:there\\s*,?\\s*)?${HONORIFIC}(${NAME})\\s*[,:!\\n\\-]`,
    "iu",
  );
  const m = head.match(greetingRegex);
  if (m && m[1]) {
    const name = m[1].trim();
    // "there" shouldn't pass as a first name — guard.
    if (/^(there|all|team|everyone|folks)$/i.test(name)) return "";
    return name;
  }

  return "";
}
