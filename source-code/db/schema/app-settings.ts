import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Global, app-wide key/value settings. One row per setting key. Used for
// system-level switches that are not scoped to a single user.
//
// Current keys:
//   'global_pause' — value 'true' | 'false'. When 'true', the scheduler's
//                    bulk cron processing and bulk auto-queue stop for every
//                    user. Per-user pauses (users.paused_by_admin) are a
//                    separate mechanism and stay independent of this switch.
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AppSetting = typeof appSettingsTable.$inferSelect;

export const GLOBAL_PAUSE_KEY = "global_pause";
