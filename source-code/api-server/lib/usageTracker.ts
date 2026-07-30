// B7r: best-effort usage recorder.
//
// Called from inside the followup generators after each anthropic
// messages.create response. Wrapped in try/catch and the surrounding
// logic explicitly ignores failures — a DB hiccup here can never
// break a follow-up send.
//
// The recorded row is the unit of attribution for the activity log:
// one row per LLM call, with enough context to roll up per-user,
// per-app, per-stage, per-model, or per-time-window.

import type Anthropic from "@anthropic-ai/sdk";
import { db, followupUsageTable } from "@workspace/db";
import { logger } from "./logger";
import { computeCostUsd, MODEL_PRICES } from "./pricing";
import { getUsageContext } from "./usageContext";
import type { GeminiUsageMetadata } from "./gemini";

type AnthropicMessage = Anthropic.Messages.Message;

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

/**
 * Record one anthropic call's usage. Reads the active usage context
 * (set by scheduler.runWithUsageContext) and writes one row to
 * followup_usage. Never throws — any failure is logged and swallowed.
 *
 * Safe to call inline after `anthropic.messages.create(...)`.
 *
 * @param response   The full Anthropic response object (we read .model
 *                   and .usage off it).
 * @param label      Which call inside the generator pipeline this was.
 */
export async function recordUsageBestEffort(
  response: AnthropicMessage,
  label: GeneratorLabel,
): Promise<void> {
  try {
    const ctx = getUsageContext();
    if (!ctx) {
      // Generator was called outside of runWithUsageContext (e.g. from
      // a future preview/test path). Skip silently.
      return;
    }
    const usage = response.usage;
    if (!usage) return;
    const model = response.model || "unknown";
    if (!MODEL_PRICES[model]) {
      logger.warn(
        { model, label },
        "B7r: unknown model in pricing table; using DEFAULT_PRICE (cost may be inaccurate)",
      );
    }
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    // Anthropic v0+ exposes these as optional fields on usage.
    const cacheCreationTokens =
      (usage as unknown as { cache_creation_input_tokens?: number })
        .cache_creation_input_tokens ?? 0;
    const cacheReadTokens =
      (usage as unknown as { cache_read_input_tokens?: number })
        .cache_read_input_tokens ?? 0;
    // Anthropic server-side tool uses (web search etc.) — usage shape
    // varies across SDK versions. Use optional-chain access.
    const webSearches =
      (usage as unknown as { server_tool_use?: { web_search_requests?: number } })
        .server_tool_use?.web_search_requests ?? 0;

    const costUsd = computeCostUsd(model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });

    // RH-1: the ledger insert often fires immediately after a long LLM
    // call, exactly when the pool is most likely to need a fresh
    // connection. One retry with a short pause absorbs the transient
    // handshake stalls that previously dropped these rows. Still strictly
    // best-effort: the outer catch swallows a second failure.
    const row = {
      followupId: ctx.followupId,
      prospectId: ctx.prospectId,
      userId: ctx.userId,
      app: ctx.app,
      stage: ctx.stage,
      label,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      webSearches,
      costUsd: costUsd.toFixed(6),
    };
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await db.insert(followupUsageTable).values(row);
        return;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) throw err;
        logger.warn(
          { err: String(err), label, attempt },
          "B7r/RH-1: recordUsage insert failed — retrying once",
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  } catch (err) {
    logger.error({ err, label }, "B7r: recordUsage failed (non-fatal)");
  }
}

// Aux usage recorder for LLM calls made OUTSIDE the follow-up generation
// pipeline (reply-sentiment classification, email summarization). Those run
// without a usage context, so this sibling records cost straight off the
// response with an explicit app label and no followup/prospect/user
// attribution. Strictly best-effort: never throws. Rows land in the same
// followup_usage ledger, so the daily budget cap sums them into tool-wide
// spend without gating these calls.
export async function recordAuxUsageBestEffort(
  response: AnthropicMessage,
  app: string,
  label: string,
): Promise<void> {
  try {
    const usage = response.usage;
    if (!usage) return;
    const model = response.model || "unknown";
    if (!MODEL_PRICES[model]) {
      logger.warn({ model, label }, "aux usage: unknown model in pricing table; using DEFAULT_PRICE");
    }
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheCreationTokens =
      (usage as unknown as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0;
    const cacheReadTokens =
      (usage as unknown as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;
    const webSearches =
      (usage as unknown as { server_tool_use?: { web_search_requests?: number } }).server_tool_use
        ?.web_search_requests ?? 0;
    const costUsd = computeCostUsd(model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
    });
    const row = {
      followupId: null as number | null,
      prospectId: null as number | null,
      userId: null as number | null,
      app,
      stage: 0,
      label,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      webSearches,
      costUsd: costUsd.toFixed(6),
    };
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await db.insert(followupUsageTable).values(row);
        return;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  } catch (err) {
    logger.error({ err, app, label }, "aux usage record failed (non-fatal)");
  }
}

// Gemini aux usage recorder — the Gemini twin of recordAuxUsageBestEffort, for
// Gemini calls made OUTSIDE the follow-up pipeline (email summarization during
// ingest). Maps the Gemini usageMetadata shape onto the same followup_usage
// ledger row with an explicit app/label and no followup/prospect/user
// attribution (there is no usage context during ingest). Best-effort: never
// throws.
export async function recordGeminiAuxUsageBestEffort(
  usage: GeminiUsageMetadata,
  model: string,
  app: string,
  label: string,
): Promise<void> {
  try {
    if (!usage) return;
    if (!MODEL_PRICES[model]) {
      logger.warn({ model, label }, "Gemini aux usage: unknown model in pricing table; using DEFAULT_PRICE");
    }
    const prompt = usage.promptTokenCount ?? 0;
    const cached = usage.cachedContentTokenCount ?? 0;
    const inputTokens = Math.max(0, prompt - cached);
    const outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
    const costUsd = computeCostUsd(model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
    });
    const row = {
      followupId: null as number | null,
      prospectId: null as number | null,
      userId: null as number | null,
      app,
      stage: 0,
      label,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
      webSearches: 0,
      costUsd: costUsd.toFixed(6),
    };
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await db.insert(followupUsageTable).values(row);
        return;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  } catch (err) {
    logger.error({ err, app, label }, "Gemini aux usage record failed (non-fatal)");
  }
}

// Gemini critic usage recorder. Mirrors recordUsageBestEffort but maps the
// Gemini usageMetadata shape onto the same followup_usage ledger row, so the
// activity log treats a Gemini critic call exactly like an Anthropic one.
// promptTokenCount is the full prompt; cachedContentTokenCount is the cached
// portion, subtracted so it is not double-billed. thoughtsTokenCount (thinking
// tokens) bills as output, same as the visible answer tokens.
export async function recordGeminiUsageBestEffort(
  usage: GeminiUsageMetadata,
  model: string,
  label: GeneratorLabel,
): Promise<void> {
  try {
    const ctx = getUsageContext();
    if (!ctx) return;
    if (!usage) return;
    if (!MODEL_PRICES[model]) {
      logger.warn(
        { model, label },
        "Gemini: unknown model in pricing table; using DEFAULT_PRICE (cost may be inaccurate)",
      );
    }
    const prompt = usage.promptTokenCount ?? 0;
    const cached = usage.cachedContentTokenCount ?? 0;
    const inputTokens = Math.max(0, prompt - cached);
    const outputTokens =
      (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);

    const costUsd = computeCostUsd(model, {
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
    });

    const row = {
      followupId: ctx.followupId,
      prospectId: ctx.prospectId,
      userId: ctx.userId,
      app: ctx.app,
      stage: ctx.stage,
      label,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
      webSearches: 0,
      costUsd: costUsd.toFixed(6),
    };
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await db.insert(followupUsageTable).values(row);
        return;
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) throw err;
        logger.warn(
          { err: String(err), label, attempt },
          "Gemini recordUsage insert failed. Retrying once",
        );
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
  } catch (err) {
    logger.error({ err, label }, "Gemini recordUsage failed (non-fatal)");
  }
}
