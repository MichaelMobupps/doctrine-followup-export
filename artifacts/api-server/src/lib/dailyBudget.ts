import { db, appSettingsTable, followupUsageTable } from "@workspace/db";
import { eq, gte, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  DAILY_BUDGET_CAP_KEY,
  DAILY_BUDGET_ENABLED_KEY,
  getBudgetTimeZone,
  resolveCapUsd,
  startOfBudgetDayUtc,
} from "./dailyBudgetMath";

/**
 * Global daily budget cap for the whole Follow-up tool.
 *
 * The tool already writes one cost row per LLM call to followup_usage (see
 * usageTracker.ts). Summing cost_usd across ALL users, ALL generation flows
 * (doctrine / context / anti_ghosting), and the auxiliary calls (reply
 * sentiment, email summary) over the current budget day gives the tool-wide
 * spend this cap governs. No new tables are needed.
 *
 * Budget day boundary: local midnight in Asia/Jerusalem (override with
 * DOCTRINE_BUDGET_TZ). The process runs pinned to UTC, so the boundary is
 * computed with Intl in dailyBudgetMath, not with local Date methods.
 *
 * Persistence keys in app_settings:
 *   daily_budget_cap_usd   - the cap in USD (admin-editable; default 500)
 *   daily_budget_enabled   - 'true' | 'false' kill switch (default ON)
 *
 * Enforcement lives in scheduler.processDueFollowups: when enabled and the
 * day's spend has reached the cap, the bulk cron path generates nothing and
 * every due follow-up stays 'queued' until the next reset.
 */

async function readSetting(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: appSettingsTable.value })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

// Sum of cost_usd across every usage row generated at/after `since`.
export async function getSpendSinceUsd(since: Date): Promise<number> {
  const rows = await db
    .select({
      total: sql<string>`COALESCE(SUM(${followupUsageTable.costUsd}), 0)`,
    })
    .from(followupUsageTable)
    .where(gte(followupUsageTable.generatedAt, since));
  return Number(rows[0]?.total ?? 0);
}

export interface DailyBudgetState {
  enabled: boolean;
  capUsd: number;
  spentUsd: number;
  remainingUsd: number;
  exceeded: boolean;
  windowStartUtc: Date;
  timeZone: string;
}

/**
 * Live budget state for the current budget day.
 *
 * Fail-open: a transient DB read error returns exceeded=false and logs, so a
 * database blip can never silently freeze sending for the whole team. This
 * matches globalPause and the approximate-cap philosophy of sendBudget.
 *
 * The cap is approximate by a bounded amount: one process_due tick handles at
 * most 20 rows, so the day's spend can overshoot the cap by at most one
 * tick's batch before the next tick skips entirely.
 */
export async function getDailyBudgetState(
  now: Date = new Date(),
): Promise<DailyBudgetState> {
  const timeZone = getBudgetTimeZone();
  const windowStartUtc = startOfBudgetDayUtc(now, timeZone);
  try {
    const [capRaw, enabledRaw, spentUsd] = await Promise.all([
      readSetting(DAILY_BUDGET_CAP_KEY),
      readSetting(DAILY_BUDGET_ENABLED_KEY),
      getSpendSinceUsd(windowStartUtc),
    ]);
    const capUsd = resolveCapUsd(capRaw);
    // Default ON. Only an explicit 'false' disables enforcement.
    const enabled = enabledRaw === null ? true : enabledRaw !== "false";
    const remainingUsd = Math.max(0, capUsd - spentUsd);
    return {
      enabled,
      capUsd,
      spentUsd,
      remainingUsd,
      exceeded: spentUsd >= capUsd,
      windowStartUtc,
      timeZone,
    };
  } catch (err) {
    logger.error(
      { err },
      "getDailyBudgetState read failed - failing open (treating as under budget)",
    );
    const capUsd = resolveCapUsd(null);
    return {
      enabled: true,
      capUsd,
      spentUsd: 0,
      remainingUsd: capUsd,
      exceeded: false,
      windowStartUtc,
      timeZone,
    };
  }
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: sql`NOW()` },
    });
}

// Update the cap and/or the enable switch. Validates the cap is positive.
export async function setDailyBudget(args: {
  capUsd?: number;
  enabled?: boolean;
}): Promise<void> {
  const ops: Promise<unknown>[] = [];
  if (args.capUsd !== undefined) {
    if (!Number.isFinite(args.capUsd) || args.capUsd <= 0) {
      throw new Error("cap_usd must be a positive number");
    }
    ops.push(upsertSetting(DAILY_BUDGET_CAP_KEY, String(args.capUsd)));
  }
  if (args.enabled !== undefined) {
    ops.push(
      upsertSetting(DAILY_BUDGET_ENABLED_KEY, args.enabled ? "true" : "false"),
    );
  }
  await Promise.all(ops);
  logger.info(
    { capUsd: args.capUsd, enabled: args.enabled },
    "Daily budget settings updated",
  );
}
