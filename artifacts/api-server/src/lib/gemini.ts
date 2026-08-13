/**
 * Google AI Studio (Gemini API) transport.
 *
 * Pure HTTP transport for the Generative Language REST API. Used by the
 * critic provider to run the critic stage on a configurable Gemini model
 * (default Gemini 3 Flash Preview) at lower token cost than the Opus critic. This module knows nothing about the follow-up
 * domain. It sends a system instruction plus one user turn and returns the
 * raw text and usage metadata. Prompt construction, JSON parsing, and usage
 * recording live in the caller (services/criticProvider.ts).
 *
 * Auth: a Google AI Studio API key in the GEMINI_API_KEY env var, sent as the
 * x-goog-api-key header. Add it as a Replit Secret on BOTH the workspace and
 * the deployment, the same as ANTHROPIC_API_KEY. Get a key at
 * https://aistudio.google.com/apikey
 *
 * Resilience: Gemini models can return transient 503 UNAVAILABLE
 * under load, and Google asks callers to retry. This transport retries 429 and
 * 5xx responses and aborts and network errors with exponential backoff, up to
 * GEMINI_MAX_ATTEMPTS (default 3). After attempts are exhausted it throws, and
 * the caller falls back to the Sonnet critic, so a sustained outage still
 * degrades safely.
 *
 * Tunables, all optional:
 *   GEMINI_CRITIC_THINKING  LOW | MEDIUM | HIGH   (default MEDIUM)
 *   GEMINI_MAX_ATTEMPTS     1..6                  (default 3)
 *   GEMINI_TIMEOUT_MS       5000..300000          (default 60000, per attempt)
 *
 * No new dependency: this uses the Node global fetch (Node 18+). The fetch and
 * AbortController globals are reached through globalThis with local types, so
 * the file typechecks regardless of the tsconfig lib or @types/node version.
 */
import { logger } from "./logger";
// F-3.7b: the row-level generation budget. Both helpers are no-ops when no
// generation is in scope, so routes, scripts and tests are unaffected.
import { assertGenerationBudget, clampToGenerationBudget } from "./generationDeadline";

export const GEMINI_CRITIC_MODEL = process.env.GEMINI_CRITIC_MODEL || "gemini-3-flash-preview";

export type ThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

function resolveThinkingLevel(): ThinkingLevel {
  const v = (process.env.GEMINI_CRITIC_THINKING || "MEDIUM").toUpperCase();
  if (v === "MINIMAL" || v === "LOW" || v === "HIGH" || v === "MEDIUM") return v;
  return "MEDIUM";
}

function resolveMaxAttempts(): number {
  const n = Number(process.env.GEMINI_MAX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.floor(n) : 3;
}

function resolveTimeoutMs(): number {
  const n = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 && n <= 300000 ? Math.floor(n) : 60000;
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiJsonResult {
  text: string;
  usage: GeminiUsageMetadata;
  model: string;
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

interface GeminiCandidatePart {
  text?: string;
}
interface GeminiCandidate {
  content?: { parts?: GeminiCandidatePart[] };
  finishReason?: string;
}
interface GeminiResponseBody {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
}

// Minimal local shapes for the runtime globals so this file never depends on
// ambient fetch / Response / AbortController types being present.
interface MinimalResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}
type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: unknown;
  },
) => Promise<MinimalResponse>;
interface AbortControllerLike {
  signal: unknown;
  abort(): void;
}
type AbortControllerCtor = new () => AbortControllerLike;

const runtime = globalThis as unknown as {
  fetch?: FetchLike;
  AbortController?: AbortControllerCtor;
};

// Google asks callers to retry these. 429 is rate limiting, 5xx is overload.
const RETRYABLE_STATUS = new Set<number>([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    (e as { name?: string }).name === "AbortError"
  );
}

// undici raises a TypeError (often "fetch failed") on transient network errors.
function isRetryableThrow(e: unknown): boolean {
  return isAbortError(e) || e instanceof TypeError;
}

function backoffMs(attempt: number): number {
  const base = Math.min(4000, 500 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/**
 * Run one Gemini generateContent call that returns JSON, with bounded retry.
 *
 * Sends `systemParts` as the systemInstruction and `user` as a single user
 * turn, with responseMimeType application/json so the model emits a bare JSON
 * object with no markdown fences. Returns the raw text for the caller to parse.
 *
 * Retries transient failures (429, 5xx, abort, network) up to GEMINI_MAX_ATTEMPTS.
 * Throws on missing key, a non-retryable status, a safety block, empty text, or
 * after retries are exhausted. The caller treats any throw as "Gemini
 * unavailable" and falls back to the Sonnet critic, so failures degrade
 * safely.
 */
export async function geminiGenerateJson(args: {
  systemParts: string[];
  user: string;
  maxOutputTokens?: number;
  model?: string;
  // Optional per-call override. When omitted, falls back to the env-resolved
  // critic thinking level (GEMINI_CRITIC_THINKING). The writer passes its own
  // resolved level so the writer and critic tune thinking independently.
  thinkingLevel?: ThinkingLevel;
  // Optional structured-output schema. When provided it is passed as
  // generationConfig.responseSchema so the model is constrained to the shape and
  // cannot emit malformed JSON. The writer passes a subject/body schema; the
  // critic omits it and relies on the prompt contract.
  responseSchema?: Record<string, unknown>;
}): Promise<GeminiJsonResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const maybeFetch = runtime.fetch;
  if (typeof maybeFetch !== "function") {
    throw new Error("global fetch is unavailable in this runtime");
  }
  // Pin to a typed const so the nested fetchOnce helper sees a defined value;
  // a closure does not inherit the typeof narrowing above.
  const fetchFn: FetchLike = maybeFetch;

  const model = args.model || GEMINI_CRITIC_MODEL;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const thinkingLevel = args.thinkingLevel ?? resolveThinkingLevel();

  const payload = JSON.stringify({
    systemInstruction: {
      parts: args.systemParts.map((text) => ({ text })),
    },
    contents: [{ role: "user", parts: [{ text: args.user }] }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(args.responseSchema ? { responseSchema: args.responseSchema } : {}),
      thinkingConfig: { thinkingLevel },
      maxOutputTokens: args.maxOutputTokens ?? 8192,
    },
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };

  const baseTimeoutMs = resolveTimeoutMs();

  async function fetchOnce(): Promise<MinimalResponse> {
    // F-3.7b: an attempt must never outlive the row's generation budget.
    // Clamped per attempt, not once, because the budget drains as the row runs.
    // Unchanged (returns baseTimeoutMs) outside a generation.
    const timeoutMs = clampToGenerationBudget(baseTimeoutMs);
    const AbortCtl = runtime.AbortController;
    const controller = AbortCtl ? new AbortCtl() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetchFn(url, {
        method: "POST",
        headers,
        body: payload,
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const maxAttempts = resolveMaxAttempts();
  let lastErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // F-3.7b: same rule as the Anthropic ladder — do not start what the row
    // can no longer afford.
    assertGenerationBudget(`gemini ${model} attempt ${attempt}`);
    let res: MinimalResponse;
    try {
      res = await fetchOnce();
    } catch (err) {
      if (isRetryableThrow(err) && attempt < maxAttempts) {
        lastErr = err;
        logger.warn(
          { err: String(err), attempt, model },
          "Gemini request error, retrying",
        );
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const e = new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
        lastErr = e;
        logger.warn(
          { status: res.status, attempt, model },
          "Gemini transient status, retrying",
        );
        await sleep(backoffMs(attempt));
        continue;
      }
      throw e;
    }

    const json = (await res.json()) as GeminiResponseBody;

    const blockReason = json.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini blocked the request: ${blockReason}`);
    }

    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("").trim();
    if (!text) {
      const finish = json.candidates?.[0]?.finishReason ?? "unknown";
      throw new Error(`Gemini returned no text content (finishReason=${finish})`);
    }

    logger.debug(
      { model, thinkingLevel, attempt },
      "Gemini generateContent completed",
    );

    return {
      text,
      usage: json.usageMetadata ?? {},
      model,
    };
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Gemini request failed after all attempts");
}
