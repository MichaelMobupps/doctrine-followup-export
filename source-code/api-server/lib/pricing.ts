// B7r: LLM pricing table & cost calculator.
//
// All prices are USD per 1,000,000 tokens. Three vendors live here because the
// ledger is single-table: one followup_usage row per LLM call, whoever served
// it, so the activity log and the daily budget cap can sum across providers
// without knowing about any of them.
//
// The Anthropic rows are retained even though no code path calls Anthropic any
// more (Aug 2026, see lib/modelPolicy.ts): historical ledger rows still carry
// those model strings, and the activity report re-costs them from this table.
// Deleting the rows would silently re-price the past at DEFAULT_PRICE.
//
// Prices verified: Anthropic May 2026; Gemini and OpenAI 27 Aug 2026, from the
// vendors' own pricing pages.
//
// Edit MODEL_PRICES below if rates change. The activity log endpoint
// reads this table directly so updates flow through automatically.
//
// Mirror of prospector/core/pricing.py in the Email Prospector repo.
// Keep the two in sync when prices change.

export interface ModelPrice {
  input: number;   // USD per 1M input tokens
  output: number;  // USD per 1M output tokens
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Opus tier
  "claude-opus-4-8":           { input: 5.00,  output: 25.00 }, // adaptive/high-effort critic
  "claude-opus-4-7":           { input: 5.00,  output: 25.00 },
  "claude-opus-4-6":           { input: 5.00,  output: 25.00 },
  "claude-opus-4-5":           { input: 5.00,  output: 25.00 },
  "claude-opus-4-1":           { input: 15.00, output: 75.00 }, // legacy
  "claude-opus-4":             { input: 15.00, output: 75.00 }, // legacy

  // Sonnet tier
  "claude-sonnet-4-6":         { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-5-20250929":{ input: 3.00,  output: 15.00 },
  "claude-sonnet-4-5":         { input: 3.00,  output: 15.00 },
  "claude-sonnet-4":           { input: 3.00,  output: 15.00 },
  "claude-3-7-sonnet-latest":  { input: 3.00,  output: 15.00 }, // legacy

  // Haiku tier
  "claude-haiku-4-5-20251001": { input: 1.00,  output: 5.00 },
  "claude-haiku-4-5":          { input: 1.00,  output: 5.00 },
  "claude-haiku-3-5":          { input: 0.80,  output: 4.00 },

  // ---- Gemini (Google AI Studio) ----
  // Verified against ai.google.dev/gemini-api/docs/pricing, 27 Aug 2026.
  // NOTE: gemini-3.6/3.7-flash carry promotional pricing through 31 Dec 2026;
  // both rates DOUBLE on 1 Jan 2027. Revisit the chains in lib/modelPolicy.ts
  // before then — at 1.50/7.50 gemini-3.7-flash stops being the obvious
  // step-up tier.
  "gemini-3.7-flash":          { input: 0.75,  output: 3.75 },
  "gemini-3.6-flash":          { input: 0.75,  output: 3.75 },
  "gemini-3.5-flash":          { input: 1.50,  output: 9.00 },
  "gemini-3.5-flash-lite":     { input: 0.30,  output: 2.50 },
  "gemini-3.1-pro-preview":    { input: 2.00,  output: 12.00 },
  "gemini-3-flash-preview":    { input: 0.50,  output: 3.00 },
  "gemini-3.1-flash-lite":     { input: 0.25,  output: 1.50 },
  "gemini-3.1-flash-lite-preview": { input: 0.25, output: 1.50 },
  "gemini-2.5-flash":          { input: 0.30,  output: 2.50 },
  "gemini-2.5-flash-lite":     { input: 0.10,  output: 0.40 },
  "gemini-2.5-pro":            { input: 1.25,  output: 10.00 },

  // ---- OpenAI ----
  // Verified against developers.openai.com/api/docs/pricing, 27 Aug 2026.
  // The `output` rate is what hidden reasoning tokens bill at too, which is why
  // lib/llmRouter.ts folds reasoning tokens into outputTokens rather than
  // reporting them separately: a reasoning model priced on its visible answer
  // alone reads several times cheaper than it is.
  "gpt-5.5":                   { input: 5.00,  output: 30.00 },
  "gpt-5.4":                   { input: 2.50,  output: 15.00 },
  "gpt-5.4-mini":              { input: 0.75,  output: 4.50 },
  "gpt-5.4-nano":              { input: 0.20,  output: 1.25 },
  "gpt-5.2":                   { input: 1.75,  output: 14.00 },
  "gpt-5.1":                   { input: 1.25,  output: 10.00 },
  "gpt-5":                     { input: 1.25,  output: 10.00 },
  "gpt-5-mini":                { input: 0.25,  output: 2.00 },
  "gpt-5-nano":                { input: 0.05,  output: 0.40 },
  "gpt-4.1":                   { input: 2.00,  output: 8.00 },
  "gpt-4.1-mini":              { input: 0.40,  output: 1.60 },
  "gpt-4.1-nano":              { input: 0.10,  output: 0.40 },
  "gpt-4o-mini":               { input: 0.15,  output: 0.60 },
};

// Used when an unknown model string slips through. We log a warning
// (in usageTracker) and still attribute a non-zero cost so the ledger
// stays accurate to within an order of magnitude.
//
// Deliberately pessimistic: an unknown model is more likely to be a new,
// dearer tier than a new, cheaper one, and a ledger that under-reports is
// worse than one that over-reports — the daily budget cap reads these rows.
export const DEFAULT_PRICE: ModelPrice = { input: 3.00, output: 15.00 };

export function getModelPrice(model: string): ModelPrice {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Tolerate dated suffixes. Anthropic stamps them as "-20250929"; OpenAI as
  // "-2026-03-17"; Gemini preview ids carry no date. Strip either shape and
  // retry, so a pinned dated model id still bills at its family's rate instead
  // of silently falling through to DEFAULT_PRICE.
  const m = model.match(/^([a-z0-9.\-]+?)(-\d{8}|-\d{4}-\d{2}-\d{2})$/i);
  if (m && MODEL_PRICES[m[1]]) return MODEL_PRICES[m[1]];
  return DEFAULT_PRICE;
}

// Cache rate multipliers.
//
// Anthropic: cache write 1.25x input, cache read 0.10x input (their public docs).
// Gemini and the gpt-5 family also read cached input at 0.10x, so the shared
// default is right for every model in the default chains.
//
// The gpt-4.1 / gpt-4o generation is the exception — its cached-input rate is a
// larger fraction of the base rate (0.25x for gpt-4.1-mini, 0.5x for
// gpt-4o-mini), so those get an explicit override. A missing entry means "use
// the 0.10x default", which is the correct behaviour for everything else.
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.10;

const CACHE_READ_MULT_OVERRIDES: Record<string, number> = {
  "gpt-4.1": 0.25,
  "gpt-4.1-mini": 0.25,
  "gpt-4.1-nano": 0.25,
  "gpt-4o-mini": 0.50,
};

function cacheReadMult(model: string): number {
  return CACHE_READ_MULT_OVERRIDES[model] ?? CACHE_READ_MULT;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function computeCostUsd(model: string, u: UsageBreakdown): number {
  const price = getModelPrice(model);
  const base = u.inputTokens * price.input + u.outputTokens * price.output;
  const cacheWrite = u.cacheCreationTokens * price.input * CACHE_WRITE_MULT;
  const cacheRead = u.cacheReadTokens * price.input * cacheReadMult(model);
  // Sum is in price-per-million units; divide by 1e6 for USD.
  const usd = (base + cacheWrite + cacheRead) / 1_000_000;
  // 6-decimal cap matches the numeric(12,6) column.
  return Math.round(usd * 1_000_000) / 1_000_000;
}
