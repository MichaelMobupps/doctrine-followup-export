import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { prospectsTable } from "./prospects";

// B9a: normalised Gmail thread history.
//
// The AntiGhosting Followuper generator needs to read the full prior
// conversation on a thread to produce a follow-up that ACKNOWLEDGEs the
// last touchpoint, BRIDGEs to a fresh reason for contact, and asks a
// SPECIFIC question. The Doctrine and Context flows only need the seed
// email itself, so they read prospects.original_body and stop there.
// AntiGhosting needs the whole chronological exchange.
//
// Rather than fetching the thread from Gmail on every generator cycle
// (slow, rate-limited, and unnecessary for messages that have not
// changed), we maintain a local mirror in thread_messages and sync it
// from Gmail on demand. gmail_message_id is the de-dupe key.
//
// Direction is computed once at sync time by comparing the From: header
// to the user's email, and stored on the row so the generator does not
// have to re-resolve user identity for every chronological read.
export type ThreadMessageDirection = "inbound" | "outbound";
export const THREAD_MESSAGE_DIRECTIONS: ThreadMessageDirection[] = [
  "inbound",
  "outbound",
];

export const threadMessagesTable = pgTable("thread_messages", {
  id: serial("id").primaryKey(),
  // The reengagement prospect this message belongs to. A single Gmail
  // thread can be marked once for AntiGhosting; all messages on that
  // thread (past and ongoing) hang off that one prospect row.
  prospectId: integer("prospect_id")
    .notNull()
    .references(() => prospectsTable.id),
  // De-dupe key. Gmail message IDs are globally unique within an
  // account. A unique index here makes upserts safe on every re-sync.
  gmailMessageId: text("gmail_message_id").notNull().unique(),
  // Denormalised thread id for fast filtering ("all messages on thread X")
  // without a join. Mirrors prospects.gmail_thread_id at insert time.
  gmailThreadId: text("gmail_thread_id").notNull(),
  // 'inbound' when From: is the prospect; 'outbound' when From: is the
  // authenticated user. Computed once at sync time so the generator
  // never has to look at user identity.
  direction: text("direction").$type<ThreadMessageDirection>().notNull(),
  // When the message was sent. Sourced from Gmail's internalDate when
  // available, falling back to the Date: header.
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  // Headers + body extracted from the Gmail payload. body holds the
  // text/plain part with HTML stripped if no plain part exists.
  fromEmail: text("from_email").notNull().default(""),
  subject: text("subject").notNull().default(""),
  snippet: text("snippet").notNull().default(""),
  body: text("body").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Generator's primary read pattern: "give me every message for this
  // prospect, oldest first." (prospect_id, sent_at) is the right
  // covering index for that query.
  index("idx_thread_messages_prospect_sent").on(table.prospectId, table.sentAt),
  // Reverse lookup: "which prospect (if any) is associated with this
  // thread id?" — used by the live re-read pause detector to find new
  // inbound messages that arrived on a tracked thread.
  index("idx_thread_messages_thread").on(table.gmailThreadId),
]);

export const insertThreadMessageSchema = createInsertSchema(threadMessagesTable).omit({
  id: true,
  createdAt: true,
});
// B8c: switched from `z.infer<typeof insertThreadMessageSchema>` to Drizzle's
// native `$inferInsert`. drizzle-zod's createInsertSchema does not preserve
// the column-level `.$type<T>()` annotation — it widens enum-narrowed
// columns back to plain `string`. That widening broke the `.values()` call
// in threadReader.ts, which expects the narrowed `ThreadMessageDirection`.
// `$inferInsert` preserves $type annotations, so the field stays
// `"inbound" | "outbound"` end-to-end. The zod schema is kept exported for
// runtime-validation use in later batches (B9b marking endpoint will use it
// to validate incoming requests; runtime validation is permissive of the
// wider zod string type since the value is checked at request boundary).
export type InsertThreadMessage = typeof threadMessagesTable.$inferInsert;
export type ThreadMessage = typeof threadMessagesTable.$inferSelect;
