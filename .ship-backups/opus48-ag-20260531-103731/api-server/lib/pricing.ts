// B7r: Anthropic API pricing table & cost calculator.
//
// Prices verified against Anthropic's published rates, May 2026.
// All prices are USD per 1,000,000 tokens.
//
// Cache pricing follows Anthropic's standard multipliers:
//   - Cache write (5-min): 1.25x base input rate
//   - Cache read:          0.10x base input rate (90% discount)
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
};

// Used when an unknown model string slips through. We log a warning
// (in usageTracker) and still attribute a non-zero cost so the ledger
// stays accurate to within an order of magnitude.
export const DEFAULT_PRICE: ModelPrice = { input: 3.00, output: 15.00 };

export function getModelPrice(model: string): ModelPrice {
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  // Tolerate dated suffixes like "-20250929" by stripping them.
  const m = model.match(/^(claude-[a-z0-9-]+?)(-\d{8})?$/);
  if (m && MODEL_PRICES[m[1]]) return MODEL_PRICES[m[1]];
  return DEFAULT_PRICE;
}

// Anthropic cache rate multipliers (per their public docs).
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.10;

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
  const cacheRead = u.cacheReadTokens * price.input * CACHE_READ_MULT;
  // Sum is in price-per-million units; divide by 1e6 for USD.
  const usd = (base + cacheWrite + cacheRead) / 1_000_000;
  // 6-decimal cap matches the numeric(12,6) column.
  return Math.round(usd * 1_000_000) / 1_000_000;
}
