import { pgTable, serial, text, integer, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const prospectsTable = pgTable("prospects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  gmailThreadId: text("gmail_thread_id").notNull(),
  prospectName: text("prospect_name").notNull().default(""),
  company: text("company").notNull().default(""),
  email: text("email").notNull(),
  vertical: text("vertical").notNull().default("non_gaming_ua"),
  subVertical: text("sub_vertical"),
  product: text("product").notNull().default("ua"),
  subject: text("subject").notNull().default(""),
  originalBodySummary: text("original_body_summary").notNull().default(""),
  originalBody: text("original_body").notNull().default(""),
  originalLanguage: text("original_language").notNull().default("en"),
  batchLabel: text("batch_label").notNull().default(""),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  replied: integer("replied").notNull().default(0),
  repliedAt: timestamp("replied_at", { withTimezone: true }),
  followupPaused: boolean("followup_paused").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_prospects_thread").on(table.gmailThreadId),
  index("idx_prospects_vertical").on(table.vertical),
  index("idx_prospects_replied").on(table.replied),
  index("idx_prospects_batch").on(table.batchLabel),
  index("idx_prospects_sent").on(table.sentAt),
  index("idx_prospects_user").on(table.userId),
]);

export const insertProspectSchema = createInsertSchema(prospectsTable).omit({ id: true, createdAt: true });
export type InsertProspect = z.infer<typeof insertProspectSchema>;
export type Prospect = typeof prospectsTable.$inferSelect;
