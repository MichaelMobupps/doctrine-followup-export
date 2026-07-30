import { pgTable, serial, integer, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

// CSD v1: Company-Shared Drafts.
//
// One row = one generated follow-up draft shared by every contact in a
// "cohort": same sender (user), same app, same normalized company, same
// ORIGINAL THREAD LANGUAGE, same stage and cycle, same campaign context
// (context_hash) and same prior-followup history (history_hash).
//
// Why this exists: the doctrine generation pipeline costs 3-7 LLM calls
// per follow-up (Sonnet draft, Opus critic, Sonnet rewrite, up to 3
// healing iterations). Six contacts at the same company at the same
// stage of the same campaign were paying that cost six times for what
// is substantively the same message. This table makes it one.
//
// Language is a FIRST-CLASS key column, not part of the hash, by
// explicit product requirement: a contact whose original thread was in
// English must never receive a Spanish shared draft. Different
// languages are different cohorts, full stop.
//
// context_hash  — sha256 over (vertical | sub_vertical | product |
//                 normalized original subject | batch key). Guarantees
//                 reuse only across contacts who received the same
//                 campaign wave with the same subject line, which also
//                 keeps Gmail reply threading clean ("Re: <subject>"
//                 matches every member's thread).
// history_hash  — sha256 over the prior SENT follow-ups (stage, subject,
//                 body) of the current cycle. A shared draft is only
//                 reused by contacts whose visible conversation history
//                 is byte-identical, so "circling back on my note about
//                 X" can never reference an angle the recipient was
//                 never sent. Cohorts that share from stage 1 stay
//                 hash-identical forever; legacy divergent campaigns
//                 simply never collide.
// reuse_count   — number of follow-ups that adopted this draft WITHOUT
//                 an LLM run. sum(reuse_count) = generation pipelines
//                 avoided. Pure observability.
export const companySharedDraftsTable = pgTable("company_shared_drafts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  app: text("app").notNull(),
  companyKey: text("company_key").notNull(),
  language: text("language").notNull(),
  stage: integer("stage").notNull(),
  cycle: integer("cycle").notNull().default(1),
  contextHash: text("context_hash").notNull(),
  historyHash: text("history_hash").notNull(),
  generatedSubject: text("generated_subject").notNull(),
  generatedBody: text("generated_body").notNull(),
  // Audit: which cohort member's context fed the generation.
  sourceProspectId: integer("source_prospect_id"),
  sourceFollowupId: integer("source_followup_id"),
  reuseCount: integer("reuse_count").notNull().default(0),
  lastReusedAt: timestamp("last_reused_at", { withTimezone: true }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uq_company_shared_drafts_cohort").on(
    table.userId,
    table.app,
    table.companyKey,
    table.language,
    table.stage,
    table.cycle,
    table.contextHash,
    table.historyHash,
  ),
  // Daily prune sweep scans by age.
  index("idx_company_shared_drafts_generated").on(table.generatedAt),
]);

export type CompanySharedDraft = typeof companySharedDraftsTable.$inferSelect;
