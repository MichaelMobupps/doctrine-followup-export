import { pgTable, serial, text, integer, timestamp, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface StageTiming {
  minDays: number;
  maxDays: number;
}

export const DEFAULT_STAGE_TIMING: StageTiming[] = [
  { minDays: 3, maxDays: 7 },
  { minDays: 10, maxDays: 14 },
  { minDays: 21, maxDays: 28 },
];

export const DEFAULT_SEND_DAYS: number[] = [1, 2, 3, 4, 5];

export type FollowupMode = "auto_send" | "review_in_app" | "draft_in_gmail";
export const FOLLOWUP_MODES: FollowupMode[] = ["auto_send", "review_in_app", "draft_in_gmail"];

// Default windows for the draft-mode timing block. Stage 1 matches the auto-send
// stage 1 default (3-7 days after initial outreach). Stages 2+ are inter-stage
// gaps measured from the *previous* stage's manual send time, so the numbers
// here are smaller than the auto-send absolute windows.
export const DEFAULT_DRAFT_STAGE_TIMING: StageTiming[] = [
  { minDays: 3, maxDays: 7 },   // F1 draft: 3-7 days after initial outreach
  { minDays: 5, maxDays: 10 },  // F2 draft: 5-10 days after user manually sends F1
  { minDays: 7, maxDays: 14 },  // F3 draft: 7-14 days after user manually sends F2
];

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default(""),
  googleRefreshToken: text("google_refresh_token"),
  isConnected: boolean("is_connected").notNull().default(false),

  stageTiming: jsonb("stage_timing").$type<StageTiming[]>().notNull().default(DEFAULT_STAGE_TIMING),
  sendDays: jsonb("send_days").$type<number[]>().notNull().default(DEFAULT_SEND_DAYS),
  sendHourStart: integer("send_hour_start").notNull().default(8),
  sendHourEnd: integer("send_hour_end").notNull().default(18),
  maxFollowups: integer("max_followups").notNull().default(3),
  doctrineLabel: text("doctrine_label").notNull().default("Doctrine SDR"),
  // Phase 7a: Gmail label that scopes ingest into the Context Based
  // Followuper. User must add this label to threads they want followed
  // up on a context-only basis (no doctrine prompts). Default chosen
  // to be self-explanatory for non-technical team members.
  contextLabel: text("context_label").notNull().default("Context Followuper"),
  // B9a: Gmail label that scopes the AntiGhosting Followuper. User adds
  // this label to a thread (typically after a call or meeting where the
  // prospect went silent) to mark the thread for re-engagement.
  // Validators run at marking time (most recent message must be the
  // user's outbound, thread must contain an inbound, most recent
  // outbound must NOT be in the followups table). Manual marking only,
  // no auto-promotion from doctrine/context.
  antiGhostingLabel: text("anti_ghosting_label").notNull().default("AntiGhosting Followuper"),
  testMode: boolean("test_mode").notNull().default(false),
  // B7u: pausedByAdmin column. When true, scheduler skips this user
  // entirely (no auto-queueing, no processing of queued follow-ups).
  // Existing queued rows are left in place and resume when unpaused.
  pausedByAdmin: boolean("paused_by_admin").notNull().default(false),
  followupMode: text("followup_mode").$type<FollowupMode>().notNull().default("auto_send"),
  draftStageTiming: jsonb("draft_stage_timing").$type<StageTiming[]>().notNull().default(DEFAULT_DRAFT_STAGE_TIMING),
  // Phase 3c: one-time confirmation gate for the first switch to Draft mode.
  // Set to TRUE after the user acknowledges the mode-switch warning modal once.
  // Subsequent mode switches (in either direction) do not re-prompt.
  hasSeenDraftModeWarning: boolean("has_seen_draft_mode_warning").notNull().default(false),

  // Phase 4: weekly digest opt-in. Defaults to FALSE so new users (created
  // in auto_send mode) do not auto-receive the digest. The migration in
  // migrate-batch4.mjs flips this to TRUE for existing review_in_app and
  // draft_in_gmail users on first run.
  weeklyDigestEnabled: boolean("weekly_digest_enabled").notNull().default(false),
  // Tracks when the cron last sent a digest to this user. Used as a 6-day
  // dedupe window to make accidental cron reruns a no-op.
  lastWeeklyDigestAt: timestamp("last_weekly_digest_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("idx_users_email").on(table.email),
  index("idx_users_connected").on(table.isConnected),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;