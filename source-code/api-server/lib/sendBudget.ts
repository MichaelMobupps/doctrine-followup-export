import { db, prospectsTable, followupsTable } from "@workspace/db";
import { and, eq, gte, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Per-user send rate limiter — Phase 6.
 *
 * Counts follow-ups with status='sent' in the last hour and last 24 hours
 * for a given user, and gates further sends if either cap is exceeded.
 *
 * Caps come from environment variables with sensible defaults tuned for
 * a free Gmail account (~150 messages/day actual limit). For Workspace
 * accounts (~2000/day), bump these via Replit Secrets:
 *
 *   DOCTRINE_HOURLY_SEND_CAP   default 30
 *   DOCTRINE_DAILY_SEND_CAP    default 200
 *
 * Rate limiting is applied ONLY to cron-driven sends. Explicit user
 * actions (`forceSend=true`) bypass the cap — this preserves the
 * "Send Now" UX for individual prospects. Bulk Send-Now is separately
 * capped at the endpoint level.
 *
 * Race semantics: the count is read just before the atomic claim. Two
 * cron ticks running concurrently could each pass the budget check
 * before either updates a row, briefly overshooting by a few sends.
 * In practice fast-tick (every 3 min) and main-tick (4×/hr) rarely
 * overlap. The cap is approximate, not strict.
 */

export interface SendBudgetResult {
  allowed: boolean;
  reason?: "hourly_cap" | "daily_cap";
  hourlyCap: number;
  dailyCap: number;
  sentLastHour: number;
  sentToday: number;
}

function readCap(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn({ envName, raw }, "Invalid send-cap env value, falling back to default");
    return fallback;
  }
  return parsed;
}

export async function checkSendBudget(args: {
  userId: number;
  now?: Date;
}): Promise<SendBudgetResult> {
  const now = args.now ?? new Date();
  const hourlyCap = readCap("DOCTRINE_HOURLY_SEND_CAP", 30);
  const dailyCap  = readCap("DOCTRINE_DAILY_SEND_CAP", 200);

  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo  = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [hourRows, dayRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        eq(prospectsTable.userId, args.userId),
        eq(followupsTable.status, "sent"),
        gte(followupsTable.sentAt, hourAgo),
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(followupsTable)
      .innerJoin(prospectsTable, eq(followupsTable.prospectId, prospectsTable.id))
      .where(and(
        eq(prospectsTable.userId, args.userId),
        eq(followupsTable.status, "sent"),
        gte(followupsTable.sentAt, dayAgo),
      )),
  ]);

  const sentLastHour = Number(hourRows[0]?.count ?? 0);
  const sentToday    = Number(dayRows[0]?.count ?? 0);

  if (sentLastHour >= hourlyCap) {
    return { allowed: false, reason: "hourly_cap", hourlyCap, dailyCap, sentLastHour, sentToday };
  }
  if (sentToday >= dailyCap) {
    return { allowed: false, reason: "daily_cap", hourlyCap, dailyCap, sentLastHour, sentToday };
  }
  return { allowed: true, hourlyCap, dailyCap, sentLastHour, sentToday };
}
