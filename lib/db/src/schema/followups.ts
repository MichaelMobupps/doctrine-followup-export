import { pgTable, serial, integer, text, timestamp, index, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { prospectsTable } from "./prospects";

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
