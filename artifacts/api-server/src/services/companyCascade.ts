/**
 * companyCascade.ts — Company-Reply Cascade engine.
 *
 * When one contact at a company replies POSITIVELY, pause the OTHER recent
 * campaigns to colleagues at that same company. "Same company" = exact email
 * host. "Recent" = sent within +/- COMPANY_CASCADE_WINDOW_DAYS of the
 * replier's outreach. Scope = the SAME mailbox owner only.
 *
 * Safety properties:
 *   - Idempotent: only pauses siblings that are currently active
 *     (followup_paused = false), so a re-run after the first pass is a no-op.
 *   - Reversible: every paused sibling records cascade_paused_by_prospect_id
 *     pointing at the reply that paused it, so undoCascadeForTrigger() can
 *     restore exactly that set.
 *   - Fail-safe gate: a settings-read error reports the feature as disabled,
 *     so a transient DB issue can never cause a wrongful cascade.
 *   - Never groups free-webmail addresses (extractEmailDomain returns "").
 *
 * The paused-reason value 'company_reply_cascade' is a widening of the
 * existing prospects.pause_reason text column (no DDL, TS-typed), matching
 * the pattern used for 'bounced' and 'admin_killed'.
 */

import { db, prospectsTable, appSettingsTable } from "@workspace/db";
import { and, eq, ne, isNull, inArray, gte, lte, desc, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cancelActiveFollowupsForProspects } from "./scheduler";
import {
  extractEmailDomain,
  windowBounds,
  COMPANY_CASCADE_WINDOW_DAYS,
  CASCADE_ELIGIBLE_APPS,
} from "../lib/replyClassification";
import { logger } from "../lib/logger";

// app_settings key for the global on/off switch.
export const COMPANY_CASCADE_ENABLED_KEY = "company_cascade_enabled";

// ──────────────────────────────────────────────────────────────────────
// On/off switch (app_settings backed; mirrors lib/globalPause.ts)
// ──────────────────────────────────────────────────────────────────────

/**
 * Whether the cascade is enabled. Default ON when no row exists.
 *
 * Fail-SAFE (opposite of globalPause): a read error returns false so a
 * transient DB problem suppresses the cascade rather than risking a wrongful
 * pause of live campaigns. The downside of failing safe is only that
 * colleagues keep getting one more follow-up — fully recoverable.
 */
export async function isCompanyCascadeEnabled(): Promise<boolean> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, COMPANY_CASCADE_ENABLED_KEY))
      .limit(1);
    if (rows.length === 0) return true; // default ON
    return rows[0].value === "true";
  } catch (err) {
    logger.error({ err }, "isCompanyCascadeEnabled read failed — defaulting to disabled (fail-safe)");
    return false;
  }
}

export async function setCompanyCascadeEnabled(enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  await db
    .insert(appSettingsTable)
    .values({ key: COMPANY_CASCADE_ENABLED_KEY, value })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: sql`NOW()` },
    });
  logger.info({ companyCascadeEnabled: enabled }, "Company-reply cascade switch updated");
}

export async function getCompanyCascadeState(): Promise<{
  enabled: boolean;
  updatedAt: string | null;
}> {
  const rows = await db
    .select({ value: appSettingsTable.value, updatedAt: appSettingsTable.updatedAt })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, COMPANY_CASCADE_ENABLED_KEY))
    .limit(1);
  if (rows.length === 0) return { enabled: true, updatedAt: null }; // default ON
  return {
    enabled: rows[0].value === "true",
    updatedAt: rows[0].updatedAt ? rows[0].updatedAt.toISOString() : null,
  };
}

// ──────────────────────────────────────────────────────────────────────
// The cascade
// ──────────────────────────────────────────────────────────────────────

export interface CascadeResult {
  enabled: boolean;
  skipped?: "disabled" | "no_company_domain";
  domain: string;
  candidateCount: number;
  pausedProspectIds: number[];
  cancelledFollowups: number;
}

/**
 * Pause active sibling campaigns at the replier's company.
 *
 * @param userId        The mailbox owner. number, or null for the legacy
 *                      single-tenant path. Siblings are scoped to this owner.
 * @param replierEmail  The address that replied positively.
 * @param replierSentAt When WE sent the replier's outreach (the recency anchor).
 * @param replierThreadId The replier's Gmail thread, excluded from the sweep.
 * @param triggerProspectId The prospect row of the positive reply; recorded on
 *                      every paused sibling for audit + undo.
 */
export async function cascadeCompanyPauseOnPositiveReply(params: {
  userId: number | null;
  replierEmail: string;
  replierSentAt: Date;
  replierThreadId: string;
  triggerProspectId: number;
}): Promise<CascadeResult> {
  const { userId, replierEmail, replierSentAt, replierThreadId, triggerProspectId } = params;

  const enabled = await isCompanyCascadeEnabled();
  const domain = extractEmailDomain(replierEmail);

  if (!enabled) {
    return { enabled, skipped: "disabled", domain, candidateCount: 0, pausedProspectIds: [], cancelledFollowups: 0 };
  }
  if (!domain) {
    // Free webmail or unparseable address: nothing to group on.
    return { enabled, skipped: "no_company_domain", domain: "", candidateCount: 0, pausedProspectIds: [], cancelledFollowups: 0 };
  }

  const { lower, upper } = windowBounds(replierSentAt, COMPANY_CASCADE_WINDOW_DAYS);
  const ownerCond = userId === null ? isNull(prospectsTable.userId) : eq(prospectsTable.userId, userId);

  // Active sibling campaigns at the same company, sent in the same window,
  // on a different thread, in a cold-outreach product, owned by the same user.
  const siblings = await db
    .select({ id: prospectsTable.id, email: prospectsTable.email })
    .from(prospectsTable)
    .where(
      and(
        ownerCond,
        inArray(prospectsTable.app, [...CASCADE_ELIGIBLE_APPS]),
        eq(prospectsTable.replied, 0),
        eq(prospectsTable.followupPaused, false),
        eq(prospectsTable.archived, false),
        ne(prospectsTable.gmailThreadId, replierThreadId),
        gte(prospectsTable.sentAt, lower),
        lte(prospectsTable.sentAt, upper),
        sql`lower(split_part(${prospectsTable.email}, '@', 2)) = ${domain}`,
      ),
    );

  const siblingIds = siblings.map((s) => s.id);
  if (siblingIds.length === 0) {
    return { enabled, domain, candidateCount: 0, pausedProspectIds: [], cancelledFollowups: 0 };
  }

  // Pause the sibling prospects. The followup_paused=false guard keeps this
  // idempotent: a sibling already paused (by anything) is left untouched.
  await db
    .update(prospectsTable)
    .set({
      followupPaused: true,
      pauseReason: "company_reply_cascade",
      pausedAt: new Date(),
      cascadePausedByProspectId: triggerProspectId,
    })
    .where(and(inArray(prospectsTable.id, siblingIds), eq(prospectsTable.followupPaused, false)));

  // Cancel their queued/generating/pending/drafted follow-ups (deletes any
  // Gmail drafts too). Idempotent on follow-up status.
  const cancelledFollowups = await cancelActiveFollowupsForProspects(
    siblingIds,
    `Company-reply cascade: a colleague at ${domain} replied positively (prospect #${triggerProspectId}).`,
  );

  logger.info(
    { userId, domain, triggerProspectId, pausedCount: siblingIds.length, cancelledFollowups, windowDays: COMPANY_CASCADE_WINDOW_DAYS },
    "Company-reply cascade paused sibling campaigns",
  );

  return { enabled, domain, candidateCount: siblingIds.length, pausedProspectIds: siblingIds, cancelledFollowups };
}

// ──────────────────────────────────────────────────────────────────────
// Audit (blast-radius view) + undo
// ──────────────────────────────────────────────────────────────────────

export interface CascadeEvent {
  trigger: { prospectId: number; email: string; company: string };
  pausedAt: string | null;
  siblings: Array<{ prospectId: number; email: string; company: string; sentAt: string | null }>;
}

/**
 * Recent cascade events, grouped by the reply that caused them. Each event
 * is one positive reply and the set of sibling campaigns it paused. Powers
 * the blast-radius admin view.
 *
 * Implemented with the Drizzle query builder and a table alias for the
 * self-join (sibling row -> the trigger prospect it points at), so the result
 * is fully typed and matches the column access used everywhere else.
 */
export async function getRecentCascadeEvents(limit = 50): Promise<CascadeEvent[]> {
  const trg = alias(prospectsTable, "trg");

  const rows = await db
    .select({
      siblingId: prospectsTable.id,
      siblingEmail: prospectsTable.email,
      siblingCompany: prospectsTable.company,
      siblingSentAt: prospectsTable.sentAt,
      pausedAt: prospectsTable.pausedAt,
      triggerId: trg.id,
      triggerEmail: trg.email,
      triggerCompany: trg.company,
    })
    .from(prospectsTable)
    .innerJoin(trg, eq(trg.id, prospectsTable.cascadePausedByProspectId))
    .where(
      and(
        eq(prospectsTable.pauseReason, "company_reply_cascade"),
        isNotNull(prospectsTable.cascadePausedByProspectId),
      ),
    )
    .orderBy(desc(prospectsTable.pausedAt))
    .limit(limit);

  const byTrigger = new Map<number, CascadeEvent>();
  for (const r of rows) {
    const triggerId = r.triggerId;
    if (!byTrigger.has(triggerId)) {
      byTrigger.set(triggerId, {
        trigger: { prospectId: triggerId, email: r.triggerEmail, company: r.triggerCompany },
        pausedAt: r.pausedAt ? r.pausedAt.toISOString() : null,
        siblings: [],
      });
    }
    byTrigger.get(triggerId)!.siblings.push({
      prospectId: r.siblingId,
      email: r.siblingEmail,
      company: r.siblingCompany,
      sentAt: r.siblingSentAt ? r.siblingSentAt.toISOString() : null,
    });
  }
  return Array.from(byTrigger.values());
}

/**
 * Undo a cascade: un-pause every sibling that was paused by a given trigger
 * reply. Clears the cascade pause reason and the link. The scheduler's
 * auto-queue picks the restored campaigns back up on its next tick (cancelled
 * follow-up rows stay cancelled; a fresh next-stage row is queued for the now
 * active prospect). Returns the number of siblings restored.
 */
export async function undoCascadeForTrigger(triggerProspectId: number): Promise<number> {
  const result = await db
    .update(prospectsTable)
    .set({
      followupPaused: false,
      pauseReason: null,
      pausedAt: null,
      cascadePausedByProspectId: null,
    })
    .where(
      and(
        eq(prospectsTable.cascadePausedByProspectId, triggerProspectId),
        eq(prospectsTable.pauseReason, "company_reply_cascade"),
      ),
    );
  const restored = result.rowCount || 0;
  logger.info({ triggerProspectId, restored }, "Company-reply cascade undone");
  return restored;
}
