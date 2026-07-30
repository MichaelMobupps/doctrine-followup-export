// B7r: per-event usage ledger for follow-up LLM generation.
// One row per Anthropic API call made on behalf of a follow-up row
// (draft / critic / rewriter pass for doctrine or context flows).
//
// We DO NOT use this table for billing — it's an observability ledger.
// Costs are estimated from the pricing table in api-server/src/lib/pricing.ts,
// which mirrors Anthropic's published rates.
//
// Foreign keys are intentionally permissive (ON DELETE SET NULL via app
// logic, not constraints) so that purging old prospects/followups never
// blocks because of usage rows.
import { pgTable, serial, integer, text, timestamp, numeric, index } from "drizzle-orm/pg-core";

export const followupUsageTable = pgTable("followup_usage", {
  id: serial("id").primaryKey(),
  // Followup this generation was attributed to. May be null only for
  // edge cases (e.g. a future preview-only generator).
  followupId: integer("followup_id"),
  prospectId: integer("prospect_id"),
  userId: integer("user_id"),
  // 'doctrine' | 'context' — matches prospects.app.
  app: text("app").notNull(),
  // The follow-up stage number being generated (1, 2, 3 ...).
  stage: integer("stage").notNull(),
  // Label of the LLM call inside the generator: "draft" | "critic" |
  // "rewriter" | "context_generator" | "context_critic" | "context_rewriter".
  label: text("label").notNull(),
  // Anthropic model identifier as returned by the API.
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheCreationTokens: integer("cache_creation_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  webSearches: integer("web_searches").notNull().default(0),
  // numeric(12, 6) -> up to $999,999.999999 with 6-decimal precision.
  // Plenty for any single call (typical call is fractions of a cent).
  costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
  generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_followup_usage_user").on(table.userId),
  index("idx_followup_usage_followup").on(table.followupId),
  index("idx_followup_usage_prospect").on(table.prospectId),
  index("idx_followup_usage_generated_at").on(table.generatedAt),
  index("idx_followup_usage_app").on(table.app),
]);
