import { pgTable, serial, integer, text, timestamp, index, unique, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { prospectsTable } from "./prospects";

// F-3.6a: one preserved failure. Appended to followups.error_history on
// every failed→queued transition, so a retried row carries the evidence of
// every attempt that came before it instead of being wiped clean.
export interface FollowupFailureRecord {
  /** ISO instant the failure was recorded. */
  at: string;
  /** Machine-readable class — see FAILURE_REASONS. */
  reason: string;
  /** The provider/DB error text, truncated. Rendered as data, never markup. */
  error: string;
  /** Which attempt this was: 0 for the first failure, 1 for the next, … */
  attempt: number;
}

/**
 * Why a follow-up row is in `failed`.
 *
 * `auth_dead`  — the owner's Gmail grant is refused by Google. Never retried
 *                automatically; it would fail identically every time and cost
 *                a full generation to learn nothing.
 * `stranded`   — the row sat in `generating` past the RH-1 threshold: the
 *                process died between the claim and the final status write.
 * `owner_missing` — F-3.6b. The prospect has no `user_id`, so there is no
 *                account to send as. Until F-3.6b such a row silently used
 *                the shared `SENDER_EMAIL` / `GOOGLE_REFRESH_TOKEN` mailbox
 *                and went out under an identity unrelated to its campaign.
 *                Now it refuses and says so. Held, not retried: no number of
 *                attempts invents an owner.
 * `send_error` — anything else thrown inside the per-row processing block.
 *
 * `failure_reason` is a plain TEXT column with no CHECK constraint — the TS
 * union is the source of truth — so adding a value needs no DDL. Same
 * widening `prospects.pause_reason` has taken twice.
 */
export const FAILURE_REASONS = ["auth_dead", "stranded", "owner_missing", "send_error"] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];
// The history cap and the retry budget live in api-server's lib/retryPolicy.ts
// — they are policy, not schema, and that file must stay importable without a
// database so its tests can run hermetically.

export const followupsTable = pgTable("followups", {
  id: serial("id").primaryKey(),
  prospectId: integer("prospect_id").notNull().references(() => prospectsTable.id),
  stage: integer("stage").notNull(),
  // B9a: renewal cycle counter, mirrors prospects.cycle. Defaults to 1
  // for all existing rows. Together with prospectId and stage forms the
  // unique constraint, so a renewed AntiGhosting campaign can re-use
  // stage numbers 1, 2, 3 ... under a new cycle without colliding.
  cycle: integer("cycle").notNull().default(1),
  status: text("status").notNull().default("queued"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  generatedBody: text("generated_body"),
  generatedSubject: text("generated_subject"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  gmailMessageId: text("gmail_message_id"),
  draftMessageId: text("draft_message_id"),
  errorMessage: text("error_message"),

  // F-3.6a: retry accounting. Before this, `failed` was not in
  // ACTIVE_FOLLOWUP_STATUSES, so autoQueueAllCampaigns revived every failed
  // row within 15 minutes — status back to queued, errorMessage nulled,
  // bodies nulled, rescheduled +1h. Every failure erased its own evidence,
  // and the failed surface could never show a real rate (F-D4, 2026-08-09:
  // two visible failed rows fleet-wide, both belonging to the one user
  // auto-queue skips).
  //
  // Revival is now a bounded policy: retryCount counts the automatic
  // retries already spent, errorHistory preserves what each attempt hit,
  // and failureReason says which class it was.
  retryCount: integer("retry_count").notNull().default(0),
  failureReason: text("failure_reason").$type<FailureReason>(),
  errorHistory: jsonb("error_history").$type<FollowupFailureRecord[]>(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // B9a: the unique constraint was previously (prospect_id, stage). The
  // AntiGhosting renewal model requires re-using stage numbers across
  // cycles, so the new constraint is (prospect_id, cycle, stage). The
  // runtime migration drops the old constraint and creates this one.
  unique("uq_followups_prospect_cycle_stage").on(table.prospectId, table.cycle, table.stage),
  index("idx_followups_status").on(table.status),
  index("idx_followups_scheduled").on(table.scheduledAt),
  index("idx_followups_prospect").on(table.prospectId),
]);

export const insertFollowupSchema = createInsertSchema(followupsTable).omit({ id: true, createdAt: true });
export type InsertFollowup = z.infer<typeof insertFollowupSchema>;
export type Followup = typeof followupsTable.$inferSelect;
