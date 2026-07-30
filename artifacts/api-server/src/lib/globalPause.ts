import { db, appSettingsTable, GLOBAL_PAUSE_KEY } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

// Global pause switch backed by app_settings('global_pause').
//
// When enabled, the scheduler stops bulk cron processing and bulk
// auto-queue for every user (see scheduler.ts). Per-user admin pauses
// (users.paused_by_admin) are a separate, independent mechanism: a global
// resume does not wake a user who was paused on purpose.

export async function isGlobalPauseEnabled(): Promise<boolean> {
  try {
    const rows = await db
      .select({ value: appSettingsTable.value })
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, GLOBAL_PAUSE_KEY))
      .limit(1);
    return rows[0]?.value === "true";
  } catch (err) {
    // Fail open: if the settings read fails we do NOT silently pause every
    // campaign. Log and treat as not-paused so a transient DB issue cannot
    // halt all sending.
    logger.error({ err }, "isGlobalPauseEnabled read failed — defaulting to not paused");
    return false;
  }
}

export async function setGlobalPause(enabled: boolean): Promise<void> {
  const value = enabled ? "true" : "false";
  await db
    .insert(appSettingsTable)
    .values({ key: GLOBAL_PAUSE_KEY, value })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value, updatedAt: sql`NOW()` },
    });
  logger.info({ globalPause: enabled }, "Global pause switch updated");
}

export async function getGlobalPauseState(): Promise<{ paused: boolean; updatedAt: string | null }> {
  const rows = await db
    .select({ value: appSettingsTable.value, updatedAt: appSettingsTable.updatedAt })
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, GLOBAL_PAUSE_KEY))
    .limit(1);
  return {
    paused: rows[0]?.value === "true",
    updatedAt: rows[0]?.updatedAt ? rows[0].updatedAt.toISOString() : null,
  };
}
