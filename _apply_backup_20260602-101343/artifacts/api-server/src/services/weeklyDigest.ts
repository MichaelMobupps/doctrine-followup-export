import { db, prospectsTable, usersTable, followupsTable } from "@workspace/db";
import { and, eq, gte, lte, sql, isNotNull } from "drizzle-orm";
import { getGmailForUser } from "./gmailClient";
import { logger } from "../lib/logger";

/**
 * Weekly digest service. Phase 4.
 *
 * Sends a weekly recap email every Tuesday 00:00 UTC to users whose
 * `weekly_digest_enabled` flag is TRUE. The email is sent through the
 * user's own Gmail OAuth credentials (no external mail service) and
 * contains six sections covering the last 7 days of activity:
 *   1. Follow-ups sent
 *   2. Replies received
 *   3. Pending approvals (review_in_app users only)
 *   4. Drafts approaching 30-day timeout (draft_in_gmail users only)
 *   5. Drafts stalled in last 7 days
 *   6. New prospects added
 *
 * The cron job in cron.ts also enforces a 6-day dedupe window via
 * `last_weekly_digest_at` so any accidental rerun within the same
 * Tuesday window is a no-op.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STALL_WARNING_DAYS = 14; // matches the Pipeline yellow tier
const STALL_HARD_DAYS = 30;    // matches stallDraftedFollowups cutoff
const DEDUPE_DAYS = 6;         // dedupe window for cron reruns

export interface DigestSection {
  title: string;
  count: number;
  rows: Array<{ label: string; meta?: string }>;
}

export interface DigestData {
  weekStart: Date;
  weekEnd: Date;
  followupMode: string;
  sentCount: number;
  sentRows: Array<{ label: string; meta?: string }>;
  repliesCount: number;
  repliesRows: Array<{ label: string; meta?: string }>;
  pendingApprovalCount: number;
  pendingApprovalRows: Array<{ label: string; meta?: string }>;
  approachingTimeoutCount: number;
  approachingTimeoutRows: Array<{ label: string; meta?: string }>;
  stalledCount: number;
  stalledRows: Array<{ label: string; meta?: string }>;
  newProspectsCount: number;
  newProspectsRows: Array<{ label: string; meta?: string }>;
  bouncedCount: number;
  bouncedRows: Array<{ label: string; meta?: string }>;
  archivedCount: number;
  archivedRows: Array<{ label: string; meta?: string }>;
}

function fmtDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function daysSince(d: Date | null | undefined, ref: Date): number {
  if (!d) return 0;
  return Math.floor((ref.getTime() - new Date(d).getTime()) / DAY_MS);
}

export async function gatherDigestData(args: {
  userId: number;
  followupMode: string;
  now?: Date;
}): Promise<DigestData> {
  const now = args.now ?? new Date();
  const weekStart = new Date(now.getTime() - 7 * DAY_MS);

  // Section 1: Sent in the last 7 days.
  // B7q: sent count is a separate count(*) so the email shows the real
  // total even when there are more than the displayed row cap.
  const sentCountRows = await db
    .select({ c: sql`count(*)`.mapWith(Number) })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(followupsTable.status, "sent"),
      isNotNull(followupsTable.sentAt),
      gte(followupsTable.sentAt, weekStart),
      lte(followupsTable.sentAt, now),
    ));
  const sentCount = sentCountRows[0]?.c ?? 0;
  const sentRows = await db
    .select({
      stage: followupsTable.stage,
      sentAt: followupsTable.sentAt,
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(followupsTable.status, "sent"),
      isNotNull(followupsTable.sentAt),
      gte(followupsTable.sentAt, weekStart),
      lte(followupsTable.sentAt, now),
    ))
    .orderBy(sql`${followupsTable.sentAt} desc`)
    .limit(200);

  // Section 2: Replies received in the last 7 days.
  // B7q: replies count via count(*).
  const repliesCountRows = await db
    .select({ c: sql`count(*)`.mapWith(Number) })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(prospectsTable.replied, 1),
      isNotNull(prospectsTable.repliedAt),
      gte(prospectsTable.repliedAt, weekStart),
      lte(prospectsTable.repliedAt, now),
    ));
  const repliesCount = repliesCountRows[0]?.c ?? 0;
  const repliesRows = await db
    .select({
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
      repliedAt: prospectsTable.repliedAt,
    })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(prospectsTable.replied, 1),
      isNotNull(prospectsTable.repliedAt),
      gte(prospectsTable.repliedAt, weekStart),
      lte(prospectsTable.repliedAt, now),
    ))
    .orderBy(sql`${prospectsTable.repliedAt} desc`)
    .limit(200);

  // Section 3: Pending approvals (review_in_app mode users see this; others get count=0).
  // B7q: pendingApproval count via count(*).
  let pendingApprovalCount = 0;
  if (args.followupMode === "review_in_app") {
    const r = await db
      .select({ c: sql`count(*)`.mapWith(Number) })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        eq(prospectsTable.userId, args.userId),
        eq(followupsTable.status, "pending_approval"),
        eq(prospectsTable.replied, 0),
        eq(prospectsTable.followupPaused, false),
      ));
    pendingApprovalCount = r[0]?.c ?? 0;
  }
  const pendingApprovalRows = args.followupMode === "review_in_app"
    ? await db
        .select({
          stage: followupsTable.stage,
          scheduledAt: followupsTable.scheduledAt,
          prospectName: prospectsTable.prospectName,
          company: prospectsTable.company,
          email: prospectsTable.email,
        })
        .from(followupsTable)
        .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
        .where(and(
          eq(prospectsTable.userId, args.userId),
          eq(followupsTable.status, "pending_approval"),
          eq(prospectsTable.replied, 0),
          eq(prospectsTable.followupPaused, false),
        ))
        .orderBy(followupsTable.scheduledAt)
        .limit(200)
    : [];

  // Section 4: Drafts approaching timeout (draft_in_gmail mode only).
  // A draft is "approaching" if its scheduledAt is between 14 and 30 days old.
  // B7q: approachingTimeout count via count(*).
  let approachingTimeoutCount = 0;
  if (args.followupMode === "draft_in_gmail") {
    const r = await db
      .select({ c: sql`count(*)`.mapWith(Number) })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        eq(prospectsTable.userId, args.userId),
        eq(followupsTable.status, "drafted"),
        lte(followupsTable.scheduledAt, new Date(now.getTime() - STALL_WARNING_DAYS * DAY_MS)),
        gte(followupsTable.scheduledAt, new Date(now.getTime() - STALL_HARD_DAYS * DAY_MS)),
      ));
    approachingTimeoutCount = r[0]?.c ?? 0;
  }
  const approachingTimeoutRows = args.followupMode === "draft_in_gmail"
    ? await db
        .select({
          stage: followupsTable.stage,
          scheduledAt: followupsTable.scheduledAt,
          prospectName: prospectsTable.prospectName,
          company: prospectsTable.company,
          email: prospectsTable.email,
        })
        .from(followupsTable)
        .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
        .where(and(
          eq(prospectsTable.userId, args.userId),
          eq(followupsTable.status, "drafted"),
          lte(followupsTable.scheduledAt, new Date(now.getTime() - STALL_WARNING_DAYS * DAY_MS)),
          gte(followupsTable.scheduledAt, new Date(now.getTime() - STALL_HARD_DAYS * DAY_MS)),
        ))
        .orderBy(followupsTable.scheduledAt)
        .limit(200)
    : [];

  // Section 5: Currently stalled drafts (all of them, regardless of age).
  // B7q: stalled section drops the broken "in last 7 days" filter. The
  // followups table has no stalledAt column so the previous proxy on
  // scheduledAt mis-included old drafts and excluded recently-stalled
  // older ones. Showing all current stalls is correct and simple.
  const stalledCountRows = await db
    .select({ c: sql`count(*)`.mapWith(Number) })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(followupsTable.status, "stalled_awaiting_manual_send"),
    ));
  const stalledCount = stalledCountRows[0]?.c ?? 0;
  const stalledRows = await db
    .select({
      stage: followupsTable.stage,
      scheduledAt: followupsTable.scheduledAt,
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
    })
    .from(followupsTable)
    .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(followupsTable.status, "stalled_awaiting_manual_send"),
    ))
    .orderBy(sql`${followupsTable.scheduledAt} desc`)
    .limit(200);

  // Section 6: New prospects added in the last 7 days.
  // B7q: newProspects count via count(*).
  const newProspectsCountRows = await db
    .select({ c: sql`count(*)`.mapWith(Number) })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      gte(prospectsTable.createdAt, weekStart),
      lte(prospectsTable.createdAt, now),
    ));
  const newProspectsCount = newProspectsCountRows[0]?.c ?? 0;
  const newProspectsRows = await db
    .select({
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
      createdAt: prospectsTable.createdAt,
    })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      gte(prospectsTable.createdAt, weekStart),
      lte(prospectsTable.createdAt, now),
    ))
    .orderBy(sql`${prospectsTable.createdAt} desc`)
    .limit(200);

  // Section 7: Campaigns auto-paused on bounce in the last 7 days.
  const bouncedCountRows = await db
    .select({ c: sql`count(*)`.mapWith(Number) })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(prospectsTable.pauseReason, "bounced"),
      isNotNull(prospectsTable.pausedAt),
      gte(prospectsTable.pausedAt, weekStart),
      lte(prospectsTable.pausedAt, now),
    ));
  const bouncedCount = bouncedCountRows[0]?.c ?? 0;
  const bouncedRows = await db
    .select({
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
      bounceType: prospectsTable.bounceType,
    })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(prospectsTable.pauseReason, "bounced"),
      isNotNull(prospectsTable.pausedAt),
      gte(prospectsTable.pausedAt, weekStart),
      lte(prospectsTable.pausedAt, now),
    ))
    .orderBy(sql`${prospectsTable.pausedAt} desc`)
    .limit(200);

  // Section 8: Campaigns archived in the last 7 days (paused >= 14 days).
  const archivedCountRows = await db
    .select({ c: sql`count(*)`.mapWith(Number) })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(prospectsTable.archived, true),
      isNotNull(prospectsTable.archivedAt),
      gte(prospectsTable.archivedAt, weekStart),
      lte(prospectsTable.archivedAt, now),
    ));
  const archivedCount = archivedCountRows[0]?.c ?? 0;
  const archivedRows = await db
    .select({
      prospectName: prospectsTable.prospectName,
      company: prospectsTable.company,
      email: prospectsTable.email,
      pauseReason: prospectsTable.pauseReason,
    })
    .from(prospectsTable)
    .where(and(
      eq(prospectsTable.userId, args.userId),
      eq(prospectsTable.archived, true),
      isNotNull(prospectsTable.archivedAt),
      gte(prospectsTable.archivedAt, weekStart),
      lte(prospectsTable.archivedAt, now),
    ))
    .orderBy(sql`${prospectsTable.archivedAt} desc`)
    .limit(200);

  return {
    followupMode: args.followupMode,
    // B7q: return uses real counts from count(*), not the length of the
    // truncated row arrays.
    sentCount,
    sentRows: sentRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: `Stage ${r.stage}`,
    })),
    repliesCount,
    repliesRows: repliesRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: r.repliedAt ? fmtDate(new Date(r.repliedAt)) : undefined,
    })),
    pendingApprovalCount,
    pendingApprovalRows: pendingApprovalRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: `Stage ${r.stage}`,
    })),
    approachingTimeoutCount,
    approachingTimeoutRows: approachingTimeoutRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: `Stage ${r.stage} · ${daysSince(r.scheduledAt, now)}d unsent`,
    })),
    stalledCount,
    stalledRows: stalledRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: `Stage ${r.stage}`,
    })),
    newProspectsCount,
    newProspectsRows: newProspectsRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
    })),
    bouncedCount,
    bouncedRows: bouncedRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: `${r.bounceType === "soft" ? "soft" : "hard"} bounce · ${r.email}`,
    })),
    archivedCount,
    archivedRows: archivedRows.map((r) => ({
      label: `${r.prospectName || r.email} · ${r.company || "(no company)"}`,
      meta: r.pauseReason === "bounced" ? "was bounced" : "paused 14+ days",
    })),
  };
}

function renderSection(title: string, count: number, rows: Array<{ label: string; meta?: string }>): string {
  if (rows.length === 0) return "";
  const items = rows.slice(0, 25).map((r) => {
    const meta = r.meta
      ? ` <span style="color:#888;font-size:12px;">(${escapeHtml(r.meta)})</span>`
      : "";
    return `<li style="margin:4px 0;font-size:13px;line-height:1.5;color:#222;">${escapeHtml(r.label)}${meta}</li>`;
  }).join("");
  const overflow = rows.length > 25
    ? `<li style="margin:4px 0;font-size:12px;color:#888;font-style:italic;">… and ${rows.length - 25} more</li>`
    : "";
  return `
    <h3 style="margin:24px 0 8px 0;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #e5e5e5;padding-bottom:4px;">
      ${escapeHtml(title)} <span style="color:#888;font-weight:400;">(${count})</span>
    </h3>
    <ul style="margin:0;padding-left:20px;list-style:disc;">${items}${overflow}</ul>
  `;
}

export function formatDigestHtml(data: DigestData, userName: string): string {
  const sections: string[] = [];

  sections.push(renderSection("Follow-ups sent", data.sentCount, data.sentRows));
  sections.push(renderSection("Replies received", data.repliesCount, data.repliesRows));

  if (data.followupMode === "review_in_app" && data.pendingApprovalCount > 0) {
    sections.push(renderSection("Pending approval", data.pendingApprovalCount, data.pendingApprovalRows));
  }

  if (data.followupMode === "draft_in_gmail" && data.approachingTimeoutCount > 0) {
    sections.push(renderSection("Drafts approaching timeout", data.approachingTimeoutCount, data.approachingTimeoutRows));
  }

  if (data.stalledCount > 0) {
    sections.push(renderSection("Drafts currently stalled", data.stalledCount, data.stalledRows));
  }

  if (data.bouncedCount > 0) {
    sections.push(renderSection("Campaigns paused on bounce", data.bouncedCount, data.bouncedRows));
  }

  if (data.archivedCount > 0) {
    sections.push(renderSection("Campaigns archived", data.archivedCount, data.archivedRows));
  }

  sections.push(renderSection("New prospects added", data.newProspectsCount, data.newProspectsRows));

  const totalActivity =
    data.sentCount + data.repliesCount + data.pendingApprovalCount +
    data.approachingTimeoutCount + data.stalledCount + data.newProspectsCount +
    data.bouncedCount + data.archivedCount;

  const emptyMsg = totalActivity === 0
    ? `<p style="font-size:13px;color:#666;margin:24px 0;">No activity in the last 7 days. The cadence is paused or all campaigns are awaiting their next scheduled stage.</p>`
    : "";

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#fafafa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:640px;margin:24px auto;padding:24px;background:#fff;border:1px solid #e5e5e5;border-radius:6px;">
    <!-- B7q: neutral HTML branding -->
    <h2 style="margin:0 0 4px 0;font-size:18px;font-weight:600;color:#111;">Weekly recap</h2>
    <p style="margin:0;font-size:12px;color:#888;">Week of ${fmtDate(data.weekStart)} — ${fmtDate(data.weekEnd)} · ${escapeHtml(userName)}</p>
    ${emptyMsg}
    ${sections.filter(Boolean).join("")}
    <p style="margin:32px 0 0 0;padding-top:16px;border-top:1px solid #e5e5e5;font-size:11px;color:#aaa;">
      You are receiving this because weekly digest is enabled in your account settings.
      To opt out, open Settings in the app and disable Weekly digest.
    </p>
  </div>
</body></html>`;
}

function encodeRawDigestMessage(rawMessage: string): string {
  return Buffer.from(rawMessage)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function mimeEncodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII headers. ASCII passes through.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

function buildDigestRawMessage(args: {
  to: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  html: string;
}): string {
  const headers = [
    `From: ${mimeEncodeHeader(args.fromName)} <${args.fromEmail}>`,
    `To: ${args.to}`,
    `Subject: ${mimeEncodeHeader(args.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    "",
    Buffer.from(args.html, "utf-8").toString("base64"),
  ];
  return encodeRawDigestMessage(headers.join("\r\n"));
}

export async function sendWeeklyDigestForUser(user: {
  id: number;
  email: string;
  name: string;
  googleRefreshToken: string;
  followupMode: string;
}): Promise<{ sent: boolean; sectionsRendered: number; reason?: string }> {
  try {
    const data = await gatherDigestData({
      userId: user.id,
      followupMode: user.followupMode,
    });

    const totalActivity =
      data.sentCount + data.repliesCount + data.pendingApprovalCount +
      data.approachingTimeoutCount + data.stalledCount + data.newProspectsCount;

    const html = formatDigestHtml(data, user.name || user.email);
    // B7q: neutral subject (covers Doctrine + Context apps under one digest).
    const subject = `Weekly recap — week of ${fmtDate(data.weekStart)}`;

    const gmail = getGmailForUser({ refreshToken: user.googleRefreshToken, email: user.email });
    const raw = buildDigestRawMessage({
      to: user.email,
      fromName: user.name || "Doctrine",
      fromEmail: user.email,
      subject,
      html,
    });

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    logger.info(
      { userId: user.id, totalActivity, sectionsRendered: 6 },
      "Sent weekly digest",
    );

    return { sent: true, sectionsRendered: 6 };
  } catch (err: any) {
    logger.error({ err, userId: user.id }, "Failed to send weekly digest");
    return { sent: false, sectionsRendered: 0, reason: err?.message || "unknown" };
  }
}

export async function runWeeklyDigest(options?: { now?: Date; force?: boolean }): Promise<{
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
}> {
  const now = options?.now ?? new Date();
  const dedupeCutoff = new Date(now.getTime() - DEDUPE_DAYS * DAY_MS);

  const eligible = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      googleRefreshToken: usersTable.googleRefreshToken,
      followupMode: usersTable.followupMode,
      lastWeeklyDigestAt: usersTable.lastWeeklyDigestAt,
    })
    .from(usersTable)
    .where(and(
      eq(usersTable.isConnected, true),
      eq(usersTable.weeklyDigestEnabled, true),
    ));

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of eligible) {
    if (!user.googleRefreshToken) {
      skipped++;
      continue;
    }
    if (!options?.force && user.lastWeeklyDigestAt && user.lastWeeklyDigestAt >= dedupeCutoff) {
      // Already sent within the dedupe window. Skip.
      skipped++;
      continue;
    }

    const result = await sendWeeklyDigestForUser({
      id: user.id,
      email: user.email,
      name: user.name,
      googleRefreshToken: user.googleRefreshToken,
      followupMode: user.followupMode,
    });

    if (result.sent) {
      await db
        .update(usersTable)
        .set({ lastWeeklyDigestAt: now })
        .where(eq(usersTable.id, user.id));
      sent++;
    } else {
      failed++;
    }
  }

  logger.info(
    { considered: eligible.length, sent, skipped, failed },
    "Weekly digest run completed",
  );

  return { considered: eligible.length, sent, skipped, failed };
}
