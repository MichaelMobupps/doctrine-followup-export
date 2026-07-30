import { pgTable, serial, text, integer, timestamp, boolean, index, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Phase 7a + B9a: discriminator that splits prospects across the three
// products running in this app:
//   'doctrine'      — Sales Doctrine Followuper (default; original flow)
//   'context'       — Context Based Followuper (Phase 7b)
//   'anti_ghosting' — AntiGhosting Followuper (B9a, re-engagement on
//                     post-engagement ghosting scenarios; manual marking only)
// The CHECK constraint at the DB level was previously claimed in the
// comment but is not actually enforced via Drizzle push. TS-level
// enforcement via `.$type<ProspectApp>()` is the source of truth.
export type ProspectApp = "doctrine" | "context" | "anti_ghosting";
export const PROSPECT_APPS: ProspectApp[] = ["doctrine", "context", "anti_ghosting"];

// B9a: pause-state discriminator used by the AntiGhosting flow. The
// existing `followupPaused` boolean stays the source of truth for
// "is this prospect paused" — `pauseReason` adds WHY when true.
// null when the prospect is not paused, or when the prospect is from
// the doctrine/context flows which only need the boolean.
//
// Admin Kill: 'admin_killed' marks a prospect (campaign) whose pipeline
// was hard-stopped by an admin via POST /api/admin/users/:id/kill. It is
// kept distinct from a bounce, a reply, or a manual pause so the reason a
// campaign is paused is unambiguous in history and audit. This is a pure
// widening of an existing plain-text column's accepted values; the column
// carries no DB CHECK constraint (TS-level typing is the source of truth),
// so no DDL is required to add it.
export type PauseReason =
  | "client_reply"          // prospect replied; campaign auto-pauses
  | "manual_intervention"   // operator sent a manual outbound mid-campaign
  | "campaign_complete"     // hard-stop after final stage
  | "bounced"               // delivery failed (bounce/NDR); address is bad
  | "admin_killed";         // admin hard-stopped this user's whole pipeline
export const PAUSE_REASONS: PauseReason[] = [
  "client_reply",
  "manual_intervention",
  "campaign_complete",
  "bounced",
  "admin_killed",
];

// Bounce classification recorded when pauseReason === 'bounced'.
//   'hard' — permanent failure (5xx, recipient does not exist)
//   'soft' — transient failure (4xx, mailbox full, temporary)
export type BounceType = "hard" | "soft";
export const BOUNCE_TYPES: BounceType[] = ["hard", "soft"];

export const prospectsTable = pgTable("prospects", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  gmailMessageId: text("gmail_message_id").notNull(),
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
  // Phase 7a: which product this prospect belongs to.
  app: text("app").$type<ProspectApp>().notNull().default("doctrine"),
  // B9a: AntiGhosting fields. All nullable so existing doctrine/context
  // rows remain unaffected; populated only when app='anti_ghosting'.
  // parentProspectId links a reengagement prospect back to the original
  // prospect it was created from (analytics + history). Null when the
  // seed thread was never an automated campaign (e.g., the operator
  // marks a thread that started from a human-typed cold email).
  parentProspectId: integer("parent_prospect_id").references((): AnyPgColumn => prospectsTable.id),
  // cycle counts renewal generations on the SAME reengagement prospect
  // row (Option A renewal model). Starts at 1, increments by 1 each
  // time the operator hits "Renew campaign" on a hard-stopped or paused
  // reengagement. Stage counter on the followups table resets per cycle.
  cycle: integer("cycle").notNull().default(1),
  // pauseReason populates WHY a prospect is paused. null when not paused.
  pauseReason: text("pause_reason").$type<PauseReason | null>(),
  // bounceType records the delivery-failure class when pauseReason='bounced'.
  // null for every other pause reason and for unpaused rows.
  bounceType: text("bounce_type").$type<BounceType | null>(),
  // pausedAt timestamps when followupPaused last flipped to true. Drives the
  // 14-day archival clock. null when the prospect is active. A daily cron
  // stamps any paused row that still has null here, so every pause site gets
  // a clock without each one having to write this column.
  pausedAt: timestamp("paused_at", { withTimezone: true }),
  // archived hides a prospect from the active pipeline lists, the dispatcher,
  // and the auto-queue. Set by the daily archival sweep after a campaign has
  // been paused for 14 days. Reversible: the row and its thread history stay
  // in place, so a re-ingest does not recreate it and history is preserved.
  archived: boolean("archived").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_prospects_thread").on(table.gmailThreadId),
  index("idx_prospects_vertical").on(table.vertical),
  index("idx_prospects_replied").on(table.replied),
  index("idx_prospects_batch").on(table.batchLabel),
  index("idx_prospects_sent").on(table.sentAt),
  index("idx_prospects_user").on(table.userId),
  // Phase 7a: per-product filter index. Most queries (sync, dispatcher,
  // pipeline list) will scope to a single app value.
  index("idx_prospects_app").on(table.app),
  // B9a: dispatcher hot-path covering index. The cron scheduler iterates
  // (app, replied=0, followupPaused=false) every cycle to find prospects
  // due for a follow-up. With three apps now and reengagement adding
  // its own dispatcher pass, this index avoids three full scans per cycle.
  index("idx_prospects_app_replied_paused").on(table.app, table.replied, table.followupPaused),
  // B9a: parent lookups (analytics view "all reengagements derived from
  // prospect X").
  index("idx_prospects_parent").on(table.parentProspectId),
  // B9b.6: scope gmail_message_id uniqueness to (user, app) so a
  // thread can carry both a doctrine prospect and an anti_ghosting
  // prospect that share the same outbound seed message. The previous
  // global UQ on the column blocked the canonical re-engagement-
  // after-doctrine pattern.
  uniqueIndex("uq_prospects_user_message_app").on(
    table.userId,
    table.gmailMessageId,
    table.app,
  ),
  // Archival sweep hot path: find paused, not-yet-archived prospects ordered
  // by how long they have been paused. Partial index keeps it tiny.
  index("idx_prospects_archive_sweep")
    .on(table.pausedAt)
    .where(sql`${table.followupPaused} = true AND ${table.archived} = false`),
  // Active-set dispatcher: the auto-queue and pipeline lists only ever care
  // about non-archived rows. Partial index over the live working set so the
  // index stays small as archived volume grows.
  index("idx_prospects_active_dispatch")
    .on(table.app, table.sentAt)
    .where(sql`${table.archived} = false`),
]);

export const insertProspectSchema = createInsertSchema(prospectsTable).omit({ id: true, createdAt: true });
export type InsertProspect = z.infer<typeof insertProspectSchema>;
export type Prospect = typeof prospectsTable.$inferSelect;