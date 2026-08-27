// B7r: best-effort usage recorder.
//
// One followup_usage row per LLM call, with enough context to roll up per-user,
// per-app, per-stage, per-model, or per-time-window. Wrapped in try/catch and
// the surrounding logic explicitly ignores failures — a DB hiccup here can never
// break a follow-up send.
//
// Aug 2026: this file used to hold four recorders, one per vendor usage dialect
// — Anthropic's {input_tokens, output_tokens, cache_*}, Gemini's
// {promptTokenCount, candidatesTokenCount, thoughtsTokenCount,
// cachedContentTokenCount} — plus an "aux" variant of each for calls made
// outside a generation. Adding OpenAI would have made six.
//
// lib/llmRouter.ts now normalizes every vendor's counts once, at the transport
// boundary, so there are two recorders: one for in-pipeline calls (which read
// the usage context) and one for auxiliary calls (which do not). The vendor
// dialects live in the router, where the transports already are.

import { db, followupUsageTable } from "@workspace/db";
import { logger } from "./logger";
import { computeCostUsd, MODEL_PRICES } from "./pricing";
import { getUsageContext } from "./usageContext";

export type GeneratorLabel =
  | "draft"
  | "critic"
  | "rewriter"
  | "context_generator"
  | "context_critic"
  | "context_rewriter"
  // B9c.2.1: AntiGhosting flow uses its own labels so usage rows
  // are attributable per product. Same shape as context_* labels.
  | "anti_ghosting_generator"
  | "anti_ghosting_critic"
  | "anti_ghosting_rewriter";

// ---------------------------------------------------------------------------
// Offline-run suppression.
// ---------------------------------------------------------------------------

// The PIPELINE recorder needs a usage context and so no-ops naturally in
// benches, but the AUX recorder writes unconditionally — that is its job, aux
// calls have no context in production either. Which means a bench that drives
// real production code (bench-llm-pipeline.ts through generateFollowupEmail,
// smoke-summarizer-cheap.ts through summarizeOriginalEmail) lands its
// ack-confirm and summarizer rows on the REAL followup_usage ledger, skewing
// per-app cost reporting and nudging the daily budget cap with dev traffic.
// The Aug 2026 audit caught bench-llm-pipeline claiming otherwise.
//
// This seam lets an offline run turn the ledger off for its own process. The
// dunder name is deliberate: nothing in production may call it, and the guard
// test's source sweep would flag a services/ or routes/ file that tried.
let ledgerSuppressed = false;

/** Offline benches and smokes ONLY. Suppresses every ledger write in-process. */
export function __setLedgerSuppressedForOfflineRuns(v: boolean): void {
  ledgerSuppressed = v;
}

// ---------------------------------------------------------------------------
// The recorders.
// ---------------------------------------------------------------------------
//
// Both take the router's normalized shape: {inputTokens, outputTokens,
// cachedInputTokens}, with cached tokens already subtracted out of inputTokens
// and hidden reasoning/thinking tokens already folded into outputTokens —
// because both vendors bill those at the output rate, and a ledger that counts
// only the visible answer understates a reasoning model several-fold.

/** Provider-neutral token counts as normalized by lib/llmRouter.ts. */
export interface NormalizedUsageInput {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

async function insertUsageRow(row: Record<string, unknown>, label: string): Promise<void> {
  // RH-1: the ledger insert often fires immediately after a long LLM call,
  // exactly when the pool is most likely to need a fresh connection. One retry
  // with a short pause absorbs the transient handshake stalls that previously
  // dropped these rows.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await db.insert(followupUsageTable).values(row as never);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      logger.warn({ err: String(err), label, attempt }, "recordLlmUsage insert failed — retrying once");
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}

/**
 * Record one in-pipeline LLM call, whatever vendor served it. Reads the active
 * usage context (set by scheduler.runWithUsageContext) and writes one row to
 * followup_usage. Never throws.
 */
export async function recordLlmUsageBestEffort(
  usage: NormalizedUsageInput,
  model: string,
  label: GeneratorLabel,
): Promise<void> {
  try {
    if (ledgerSuppressed) return;
    const ctx = getUsageContext();
    if (!ctx || !usage) return;
    if (!MODEL_PRICES[model]) {
      logger.warn(
        { model, label },
        "LLM usage: unknown model in pricing table; using DEFAULT_PRICE (cost may be inaccurate)",
      );
    }
    const costUsd = computeCostUsd(model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: usage.cachedInputTokens,
    });
    await insertUsageRow(
      {
        followupId: ctx.followupId,
        prospectId: ctx.prospectId,
        userId: ctx.userId,
        app: ctx.app,
        stage: ctx.stage,
        label,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: usage.cachedInputTokens,
        webSearches: 0,
        costUsd: costUsd.toFixed(6),
      },
      label,
    );
  } catch (err) {
    logger.error({ err, label }, "recordLlmUsage failed (non-fatal)");
  }
}

/**
 * Record one auxiliary LLM call — summarization during ingest, reply-sentiment
 * classification, the FOLLOWUP-ACK confirm. These run with no usage context, so
 * the row carries an explicit app/label and no followup/prospect/user
 * attribution. Rows land in the same ledger, so the daily budget cap sums them
 * into tool-wide spend without gating them. Never throws.
 */
export async function recordLlmAuxUsageBestEffort(
  usage: NormalizedUsageInput,
  model: string,
  app: string,
  label: string,
): Promise<void> {
  try {
    if (ledgerSuppressed) return;
    if (!usage) return;
    if (!MODEL_PRICES[model]) {
      logger.warn({ model, label }, "LLM aux usage: unknown model in pricing table; using DEFAULT_PRICE");
    }
    const costUsd = computeCostUsd(model, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: usage.cachedInputTokens,
    });
    await insertUsageRow(
      {
        followupId: null,
        prospectId: null,
        userId: null,
        app,
        stage: 0,
        label,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: usage.cachedInputTokens,
        webSearches: 0,
        costUsd: costUsd.toFixed(6),
      },
      label,
    );
  } catch (err) {
    logger.error({ err, app, label }, "LLM aux usage record failed (non-fatal)");
  }
}
