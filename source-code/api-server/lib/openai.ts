/**
 * OpenAI (api.openai.com) transport.
 *
 * The OpenAI twin of lib/gemini.ts: a pure HTTP transport for the Chat
 * Completions API, used by the LLM router (lib/llmRouter.ts) as the
 * cross-vendor half of every role's fallback waterfall. It knows nothing about
 * the follow-up domain — it sends a system instruction plus one user turn and
 * returns the raw text and usage metadata. Prompt construction, JSON parsing
 * and usage recording live in the caller.
 *
 * WHY A SECOND VENDOR AT ALL
 *
 * Every model has capacity limits. Gemini answers 503 UNAVAILABLE and 429
 * RESOURCE_EXHAUSTED under load; so does OpenAI. A waterfall built only from
 * Gemini tiers shares one quota pool and one control plane, so a Google-side
 * incident takes every tier down at once. Interleaving OpenAI tiers means a
 * whole-vendor outage costs latency, not the pipeline.
 *
 * Auth: OPENAI_API_KEY, sent as a Bearer token. Add it as a Replit Secret on
 * BOTH the workspace and the deployment.
 *
 * PARAMETER QUIRKS (probed live 2026-08-27, not assumed)
 *
 *   - gpt-5.x rejects `max_tokens` outright ("Unsupported parameter") and
 *     requires `max_completion_tokens`. gpt-4.1-x accepts both. We always send
 *     `max_completion_tokens`, which is the intersection.
 *   - `reasoning_effort` exists ONLY on gpt-5.x. gpt-4.1-x answers
 *     "Unrecognized request argument supplied: reasoning_effort" and 400s the
 *     whole call, so it is sent only when the model is in the reasoning family.
 *   - gpt-5.x supports 'none' | 'low' | 'medium' | 'high' | 'xhigh'. It does
 *     NOT support 'minimal' (that is a gpt-5.0-era value). We default to
 *     'none': reasoning tokens bill at the output rate, and an unbounded
 *     default silently triples the cost of a drafting call.
 *   - Structured output uses response_format json_schema with strict:true when
 *     the caller supplies a schema, and json_object otherwise. Both were
 *     verified live on gpt-5.4-nano, gpt-5.4-mini and gpt-4.1-mini.
 *
 * Resilience: retries 429 and 5xx responses, aborts and network errors with
 * exponential backoff, up to OPENAI_MAX_ATTEMPTS (default 3). After attempts
 * are exhausted it throws, and the router advances to the next tier in the
 * role's waterfall, so a sustained outage degrades rather than fails.
 *
 * Tunables, all optional:
 *   OPENAI_MAX_ATTEMPTS   1..6           (default 3)
 *   OPENAI_TIMEOUT_MS     5000..300000   (default 60000, per attempt)
 *   OPENAI_BASE_URL       override the API host (default https://api.openai.com/v1)
 *
 * No new dependency: Node global fetch, reached through globalThis with local
 * types, exactly as lib/gemini.ts does.
 */
import { logger } from "./logger";
// F-3.7b: the row-level generation budget. Both helpers are no-ops when no
// generation is in scope, so routes, scripts and tests are unaffected.
import { assertGenerationBudget, clampToGenerationBudget } from "./generationDeadline";

/** gpt-5.x reasoning effort. 'none' keeps reasoning tokens (billed as output) at zero. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface OpenAiUsageMetadata {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  cachedPromptTokens?: number;
  totalTokens?: number;
}

export interface OpenAiJsonResult {
  text: string;
  usage: OpenAiUsageMetadata;
  model: string;
}

export function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

function resolveMaxAttempts(): number {
  const n = Number(process.env.OPENAI_MAX_ATTEMPTS);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? Math.floor(n) : 3;
}

function resolveTimeoutMs(): number {
  const n = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 5000 && n <= 300000 ? Math.floor(n) : 60000;
}

function resolveBaseUrl(): string {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
}

/**
 * Headroom, in tokens, that a reasoning effort needs INSIDE
 * max_completion_tokens.
 *
 * The same trap as Gemini's thinking budget: reasoning tokens are billed as
 * output AND counted against the cap, so a caller sizing the cap to its ANSWER
 * silently caps the model's reasoning too. The failure mode is worse here —
 * OpenAI returns finish_reason=length with an EMPTY message, so the tier looks
 * broken rather than truncated.
 *
 * "none" needs nothing: probed live on gpt-5.4-nano and gpt-5.4-mini, it spends
 * exactly 0 reasoning tokens. Everything above it is given room.
 */
const REASONING_HEADROOM: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1024,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
};

/**
 * Raise a caller's completion cap so the reasoning budget does not eat the
 * answer. Never lowers it. Exported for the tests.
 */
export function budgetForReasoning(
  maxOutputTokens: number,
  effort: ReasoningEffort | undefined,
): number {
  if (!effort) return maxOutputTokens;
  return maxOutputTokens + REASONING_HEADROOM[effort];
}

/**
 * True for models that accept `reasoning_effort` — the gpt-5 family and the
 * o-series. Sending the field to gpt-4.1-x or gpt-4o-x is a hard 400, so this
 * gate is load-bearing, not cosmetic.
 */
export function supportsReasoningEffort(model: string): boolean {
  return /^(gpt-5|o[134])/i.test(model);
}

interface OpenAiChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}
interface OpenAiResponseBody {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string; type?: string; code?: string };
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

// 429 is rate limiting / quota; 5xx is overload or a server fault. 408 is a
// request timeout. All are worth another attempt; a 400/401/403/404 is not.
const RETRYABLE_STATUS = new Set<number>([408, 409, 429, 500, 502, 503, 504, 529]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(e: unknown): boolean {
  return (
    !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError"
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
 * Run one OpenAI chat.completions call that returns JSON, with bounded retry.
 *
 * `systemParts` are joined into a single system message (OpenAI takes one
 * system turn, unlike Gemini's parts array) and `user` becomes the single user
 * turn. When `responseSchema` is supplied the call uses strict json_schema
 * structured output, so the model cannot emit malformed JSON; otherwise it
 * falls back to json_object mode and the caller parses tolerantly.
 *
 * Retries transient failures (408/429/5xx, abort, network) up to
 * OPENAI_MAX_ATTEMPTS. Throws on missing key, a non-retryable status, a refusal
 * or empty completion, or after retries are exhausted. The router treats any
 * throw as "this tier is unavailable" and advances the waterfall.
 */
export async function openaiGenerateJson(args: {
  systemParts: string[];
  user: string;
  model: string;
  maxOutputTokens?: number;
  /** gpt-5.x only; ignored (and not sent) for models that reject the field. */
  reasoningEffort?: ReasoningEffort;
  /**
   * JSON Schema (draft-2020 subset OpenAI accepts). Passed as strict
   * json_schema structured output. OpenAI strict mode requires
   * additionalProperties:false and every property listed in `required`; the
   * router's schema translator guarantees both.
   */
  responseSchema?: Record<string, unknown>;
  /** Name for the json_schema block. Cosmetic; defaults to "response". */
  schemaName?: string;
}): Promise<OpenAiJsonResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  const maybeFetch = runtime.fetch;
  if (typeof maybeFetch !== "function") {
    throw new Error("global fetch is unavailable in this runtime");
  }
  // Pin to a typed const so the nested fetchOnce helper sees a defined value;
  // a closure does not inherit the typeof narrowing above.
  const fetchFn: FetchLike = maybeFetch;

  const model = args.model;
  const url = `${resolveBaseUrl()}/chat/completions`;

  const responseFormat = args.responseSchema
    ? {
        type: "json_schema",
        json_schema: {
          name: args.schemaName || "response",
          strict: true,
          schema: args.responseSchema,
        },
      }
    : { type: "json_object" };

  const effort: ReasoningEffort | undefined = supportsReasoningEffort(model)
    ? args.reasoningEffort ?? "none"
    : undefined;

  const payload = JSON.stringify({
    model,
    messages: [
      { role: "system", content: args.systemParts.join("\n\n") },
      { role: "user", content: args.user },
    ],
    // Always max_completion_tokens: gpt-5.x rejects max_tokens, gpt-4.1-x
    // accepts both, so this is the intersection of the two families.
    //
    // Reasoning tokens count against this cap, exactly as Gemini's thinking
    // tokens do, so the cap gets headroom when reasoning is on. When it does
    // not, the failure is not an error — it is finish_reason=length with an
    // EMPTY message, because the whole budget went to reasoning the caller
    // never sees. See budgetForReasoning.
    max_completion_tokens: budgetForReasoning(args.maxOutputTokens ?? 8192, effort),
    response_format: responseFormat,
    // Only on models that have the field. On gpt-4.1-x this key is a 400.
    ...(effort ? { reasoning_effort: effort } : {}),
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
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
    // F-3.7b: same rule as the Gemini and Anthropic ladders — do not start what
    // the row can no longer afford.
    assertGenerationBudget(`openai ${model} attempt ${attempt}`);
    let res: MinimalResponse;
    try {
      res = await fetchOnce();
    } catch (err) {
      if (isRetryableThrow(err) && attempt < maxAttempts) {
        lastErr = err;
        logger.warn(
          { err: String(err), attempt, model },
          "OpenAI request error, retrying",
        );
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      const e = new Error(`OpenAI HTTP ${res.status}: ${errText.slice(0, 300)}`);
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
        lastErr = e;
        logger.warn(
          { status: res.status, attempt, model },
          "OpenAI transient status, retrying",
        );
        await sleep(backoffMs(attempt));
        continue;
      }
      throw e;
    }

    const json = (await res.json()) as OpenAiResponseBody;

    if (json.error) {
      throw new Error(`OpenAI error: ${json.error.message ?? "unknown"}`);
    }

    const choice = json.choices?.[0];
    const text = (choice?.message?.content ?? "").trim();
    if (!text) {
      const finish = choice?.finish_reason ?? "unknown";
      // A 'length' finish on a reasoning model usually means the whole
      // completion budget went to reasoning tokens. Say so — the fix is a
      // lower reasoning_effort or a higher maxOutputTokens, not a retry.
      throw new Error(
        `OpenAI returned no text content (finish_reason=${finish})`,
      );
    }

    const u = json.usage ?? {};
    logger.debug({ model, attempt }, "OpenAI chat.completions completed");

    return {
      text,
      usage: {
        promptTokens: u.prompt_tokens,
        completionTokens: u.completion_tokens,
        reasoningTokens: u.completion_tokens_details?.reasoning_tokens,
        cachedPromptTokens: u.prompt_tokens_details?.cached_tokens,
        totalTokens: u.total_tokens,
      },
      model,
    };
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("OpenAI request failed after all attempts");
}
