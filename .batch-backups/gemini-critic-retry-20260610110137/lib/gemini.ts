/**
 * Google AI Studio (Gemini API) transport.
 *
 * Pure HTTP transport for the Generative Language REST API. Used by the
 * critic provider to run the critic stage on Gemini 3.5 Flash at lower token
 * cost than the Opus critic. This module knows nothing about the follow-up
 * domain. It sends a system instruction plus one user turn and returns the
 * raw text and usage metadata. Prompt construction, JSON parsing, and usage
 * recording live in the caller (services/criticProvider.ts).
 *
 * Auth: a Google AI Studio API key in the GEMINI_API_KEY env var, sent as the
 * x-goog-api-key header. Add it as a Replit Secret on BOTH the workspace and
 * the deployment, the same as ANTHROPIC_API_KEY. Get a key at
 * https://aistudio.google.com/apikey
 *
 * No new dependency: this uses the Node global fetch (Node 18+). The fetch and
 * AbortController globals are reached through globalThis with local types, so
 * the file typechecks regardless of the tsconfig lib or @types/node version.
 */
import { logger } from "./logger";

export const GEMINI_CRITIC_MODEL = "gemini-3.5-flash";

// Gemini 3.x thinking control. Google's guidance is to start at MEDIUM, which
// gives the best quality for the vast majority of tasks. thinkingLevel and
// thinkingBudget are mutually exclusive (sending both returns a 400), so this
// transport only ever sends thinkingLevel. Override the depth with
// GEMINI_CRITIC_THINKING=LOW|MEDIUM|HIGH.
type ThinkingLevel = "LOW" | "MEDIUM" | "HIGH";

function resolveThinkingLevel(): ThinkingLevel {
  const v = (process.env.GEMINI_CRITIC_THINKING || "MEDIUM").toUpperCase();
  if (v === "LOW" || v === "HIGH" || v === "MEDIUM") return v;
  return "MEDIUM";
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

/**
 * Run one Gemini generateContent call that returns JSON.
 *
 * Sends `systemParts` as the systemInstruction and `user` as a single user
 * turn, with responseMimeType application/json so the model emits a bare JSON
 * object with no markdown fences. Returns the raw text for the caller to parse.
 *
 * Throws on missing key, network error, timeout, non-200, safety block, or
 * empty text. The caller treats any throw as "Gemini unavailable" and falls
 * back to the Anthropic critic, so failures degrade safely.
 */
export async function geminiGenerateJson(args: {
  systemParts: string[];
  user: string;
  maxOutputTokens?: number;
  model?: string;
}): Promise<GeminiJsonResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const fetchFn = runtime.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("global fetch is unavailable in this runtime");
  }

  const model = args.model || GEMINI_CRITIC_MODEL;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const body = {
    systemInstruction: {
      parts: args.systemParts.map((text) => ({ text })),
    },
    contents: [{ role: "user", parts: [{ text: args.user }] }],
    generationConfig: {
      // Bare JSON object back, no code fences.
      responseMimeType: "application/json",
      // Thinking depth is controlled by thinkingLevel only.
      thinkingConfig: { thinkingLevel: resolveThinkingLevel() },
      // The JSON verdict is small and thoughts have their own budget that does
      // not count against maxOutputTokens. 8192 leaves generous headroom.
      maxOutputTokens: args.maxOutputTokens ?? 8192,
      // Gemini 3.x reasoning is tuned for default sampling; temperature, top_p,
      // and top_k are intentionally left unset.
    },
  };

  const AbortCtl = runtime.AbortController;
  const controller = AbortCtl ? new AbortCtl() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), 60_000)
    : null;

  const res = await (async () => {
    try {
      return await fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
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
    { model, thinkingLevel: resolveThinkingLevel() },
    "Gemini generateContent completed",
  );

  return {
    text,
    usage: json.usageMetadata ?? {},
    model,
  };
}
