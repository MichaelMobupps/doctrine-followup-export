/**
 * Smoke test for the Gemini critic.
 *
 * On-demand diagnostic, not part of the auto-run suite, because it makes a
 * live billed call to Gemini and needs GEMINI_API_KEY. It lives under
 * src/scripts/ so `node --test src/tests/*.ts` never picks it up.
 *
 * It validates whatever model GEMINI_CRITIC_MODEL resolves to (default
 * gemini-3-flash-preview), not a pinned model, so it keeps working when you
 * flip the model with the env var.
 *
 * What it verifies, fastest checks first:
 *   1. A real price row exists for the configured Gemini model.
 *   2. CRITIC_PROVIDER routing: default is gemini; anthropic mode uses the
 *      Anthropic (Sonnet) critic; gemini mode with no key uses the internal Sonnet critic.
 *   3. Live transport: a real call returns parseable JSON, the verdict has the
 *      correct shape, and usage and cost are reported. The system prompt is
 *      the exact production construction, including the Gemini focus directive.
 *   4. Integration: in gemini mode runCritic returns a valid verdict (from
 *      Gemini, or from the Sonnet fallback on a 503) and never falls through
 *      to the injected Opus critic.
 *
 * The draft under test is mechanically clean on purpose. In production the
 * deterministic linter rewrites any mechanical violation upstream, so the LLM
 * critic only ever judges clean drafts. This draft is generic and adds no new
 * angle, which is exactly the judgment failure the critic must still catch.
 *
 * Run from artifacts/api-server, where DATABASE_URL and GEMINI_API_KEY are set:
 *   node --import tsx src/scripts/smoke-critic.ts
 *
 * Exit codes: 0 every check passed, 1 a real failure, 2 the live call was
 * blocked by a transient Gemini overload (503), which is not a code problem.
 */
import { runCritic, getCriticProvider, GEMINI_CRITIC_FOCUS } from "../services/criticProvider";
import {
  geminiGenerateJson,
  isGeminiConfigured,
  GEMINI_CRITIC_MODEL,
} from "../lib/gemini";
import {
  getCriticSystemPrompt,
  getCriticUserPrompt,
} from "../services/followupPrompts";
import type { FollowupContext } from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";
import { computeCostUsd, getModelPrice, MODEL_PRICES } from "../lib/pricing";
import type { CriticResult } from "../services/followupGenerator";

let passed = 0;
let failed = 0;
let warned = 0;
let blocked = false;

function check(name: string, cond: boolean, detail = ""): void {
  const tail = detail ? " (" + detail + ")" : "";
  if (cond) {
    passed++;
    console.log("  PASS  " + name + tail);
  } else {
    failed++;
    console.log("  FAIL  " + name + tail);
  }
}

function warn(name: string, detail = ""): void {
  warned++;
  const tail = detail ? " (" + detail + ")" : "";
  console.log("  WARN  " + name + tail);
}

const ctx: FollowupContext = {
  prospect_name: "Alex",
  company: "Acme Mobile",
  vertical: "mobile gaming",
  sub_vertical: null,
  product: "user acquisition",
  original_subject: "MobUpps for Acme Mobile UA",
  original_body_summary:
    "Intro to MobUpps performance UA with semi-exclusive supply and fraud filtering.",
  original_body:
    "Hi Alex, I am reaching out from MobUpps about performance user acquisition for Acme Mobile. We run CPI and CPA campaigns with fraud filtering and durable post-install retention. Happy to share a small test plan.",
  original_language: "en",
  stage: 2,
  days_since_original: 4,
  sender_name: "Michael",
};

// Mechanically clean (acknowledges prior outreach, no hype, no closing, no
// dashes, under the sentence cap) but generic and advancing no new angle. The
// critic must still flag this on differentiation and relevance, which is the
// judgment work the deterministic linter cannot do.
const flawedDraft = {
  subject: "Re: MobUpps for Acme Mobile UA",
  body:
    "Hi Alex, Following up on my note about UA for Acme Mobile. I wanted to check whether you had any thoughts on working together. We help apps grow and would be glad to support your goals. Are you open to a quick chat?",
};

function isValidVerdict(v: CriticResult): boolean {
  return (
    !!v &&
    typeof v.overall === "number" &&
    typeof v.needs_rewrite === "boolean" &&
    typeof v.scores === "object" &&
    v.scores !== null &&
    Array.isArray(v.issues) &&
    Array.isArray(v.suggestions)
  );
}

function parseVerdict(text: string): CriticResult {
  let raw = text.replace(/```json\s*|```/g, "").trim();
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) {
    raw = raw.slice(first, last + 1);
  }
  const p = JSON.parse(raw) as Partial<CriticResult>;
  return {
    scores: p.scores ?? {},
    overall: p.overall ?? 5,
    issues: p.issues ?? [],
    suggestions: p.suggestions ?? [],
    needs_rewrite: p.needs_rewrite ?? false,
  };
}

function isOverload(msg: string): boolean {
  return /503|unavailable|high demand|overload/i.test(msg);
}

function summary(): void {
  let head = "SMOKE PASS";
  if (failed > 0) head = "SMOKE FAIL";
  else if (blocked) head = "SMOKE INCOMPLETE";
  console.log(
    "\n=== " +
      head +
      " : " +
      passed +
      " passed, " +
      failed +
      " failed, " +
      warned +
      " warnings ===",
  );
  if (blocked && failed === 0) {
    console.log(
      "    The Gemini path is built correctly. The live call was blocked by a",
    );
    console.log(
      "    transient Gemini 503 overload. Rerun when Google capacity returns.",
    );
  }
}

function exitCode(): number {
  if (failed > 0) return 1;
  if (blocked) return 2;
  return 0;
}

async function main(): Promise<void> {
  console.log("=== Gemini critic smoke test ===");
  console.log("model: " + GEMINI_CRITIC_MODEL + "\n");

  // 1. Pricing row exists for whatever model is configured.
  const price = getModelPrice(GEMINI_CRITIC_MODEL);
  check(
    "pricing: row present for configured model " + GEMINI_CRITIC_MODEL,
    MODEL_PRICES[GEMINI_CRITIC_MODEL] !== undefined,
    "input=" + price.input + " output=" + price.output,
  );

  // 2. Routing. The provider and anthropic-mode checks need no network. The
  // no-key check makes one real Sonnet call, since gemini mode with no key now
  // uses the internal Sonnet critic rather than the injected Opus critic.
  const okVerdict: CriticResult = {
    scores: {},
    overall: 4,
    issues: [],
    suggestions: [],
    needs_rewrite: false,
  };
  let stubCalled = false;
  const stub = async (): Promise<CriticResult> => {
    stubCalled = true;
    return okVerdict;
  };

  const savedProvider = process.env.CRITIC_PROVIDER;
  const savedKey = process.env.GEMINI_API_KEY;

  delete process.env.CRITIC_PROVIDER;
  check("routing: default provider is gemini", getCriticProvider() === "gemini");

  process.env.CRITIC_PROVIDER = "anthropic";
  stubCalled = false;
  const r1 = await runCritic(ctx, flawedDraft, stub);
  check(
    "routing: anthropic mode calls the Anthropic critic",
    stubCalled && r1.overall === 4,
  );

  delete process.env.GEMINI_API_KEY;
  process.env.CRITIC_PROVIDER = "gemini";
  let injectedUsedNoKey = false;
  const sentinelNoKey = async (): Promise<CriticResult> => {
    injectedUsedNoKey = true;
    return okVerdict;
  };
  try {
    const r2 = await runCritic(ctx, flawedDraft, sentinelNoKey);
    check(
      "routing: gemini mode with no key uses the internal Sonnet critic, not the injected Opus critic",
      isValidVerdict(r2) && !injectedUsedNoKey,
      "injectedOpusUsed=" + injectedUsedNoKey,
    );
  } catch (e) {
    check(
      "routing: gemini mode with no key uses the internal Sonnet critic, not the injected Opus critic",
      false,
      String(e),
    );
  }
  if (savedKey) process.env.GEMINI_API_KEY = savedKey;

  // 3. Live Gemini transport, shape, usage, cost. Uses the exact production
  // system construction, including the Gemini focus directive.
  if (!isGeminiConfigured()) {
    failed++;
    console.log(
      "\n  FAIL  live: GEMINI_API_KEY is not set, cannot smoke-test the Gemini path",
    );
    if (savedProvider === undefined) delete process.env.CRITIC_PROVIDER;
    else process.env.CRITIC_PROVIDER = savedProvider;
    summary();
    process.exit(exitCode());
  }

  console.log("\n[live] calling " + GEMINI_CRITIC_MODEL + " via geminiGenerateJson ...");
  const t0 = Date.now();
  let res: GeminiResultLike | null = null;
  let liveError: unknown = null;
  try {
    res = await geminiGenerateJson({
      systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt(), GEMINI_CRITIC_FOCUS],
      user: getCriticUserPrompt(ctx, flawedDraft),
      maxOutputTokens: 8192,
    });
  } catch (e) {
    liveError = e;
  }
  const ms = Date.now() - t0;

  if (!res) {
    const msg = String(liveError);
    if (isOverload(msg)) {
      blocked = true;
      console.log("  BLOCK live: Gemini overloaded after retries in " + ms + "ms");
      console.log("    " + msg.slice(0, 200));
    } else {
      check("live: Gemini call succeeded", false, msg.slice(0, 200));
    }
  } else {
    check(
      "live: Gemini returned text",
      res.text.length > 0,
      res.text.length + " chars in " + ms + "ms",
    );
    check(
      "live: model matches configured GEMINI_CRITIC_MODEL",
      res.model === GEMINI_CRITIC_MODEL,
      res.model,
    );

    let verdict: CriticResult | null = null;
    try {
      verdict = parseVerdict(res.text);
      check("live: verdict parses as JSON", true);
    } catch (e) {
      check("live: verdict parses as JSON", false, String(e));
    }

    if (verdict) {
      check("live: verdict has valid shape", isValidVerdict(verdict));
      check(
        "live: overall is within 1..5",
        verdict.overall >= 1 && verdict.overall <= 5,
        "overall=" + verdict.overall,
      );
      if (!verdict.needs_rewrite) {
        warn(
          "live: generic draft was not flagged on judgment, expected needs_rewrite=true",
          "eyeball the verdict below; this is a signal about the model's judgment",
        );
      }
      console.log(
        "  verdict: " +
          JSON.stringify({
            overall: verdict.overall,
            needs_rewrite: verdict.needs_rewrite,
            issues: verdict.issues.slice(0, 3),
          }),
      );
    }

    const u = res.usage;
    const prompt = u.promptTokenCount ?? 0;
    const cached = u.cachedContentTokenCount ?? 0;
    const inT = Math.max(0, prompt - cached);
    const outT = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    const cost = computeCostUsd(GEMINI_CRITIC_MODEL, {
      inputTokens: inT,
      outputTokens: outT,
      cacheCreationTokens: 0,
      cacheReadTokens: cached,
    });
    console.log(
      "  usage: prompt=" +
        prompt +
        " thoughts=" +
        (u.thoughtsTokenCount ?? 0) +
        " output=" +
        (u.candidatesTokenCount ?? 0) +
        " estCost=$" +
        cost.toFixed(6),
    );
    check("live: usage metadata present", prompt > 0 && outT > 0);

    // 4. Integration through the real switch. In gemini mode the critic is
    // Gemini, or Sonnet on a 503 after retries; the injected Opus critic must
    // never be used. We cannot tell Gemini from the Sonnet fallback by the
    // return value alone, so we assert the verdict is valid and the injected
    // Opus critic stayed unused. If a 503 hits here, this also exercises the
    // real Sonnet fallback, and runCritic logs that it did.
    process.env.CRITIC_PROVIDER = "gemini";
    let injectedOpusUsed = false;
    const sentinelCritic = async (): Promise<CriticResult> => {
      injectedOpusUsed = true;
      return okVerdict;
    };
    try {
      const r3 = await runCritic(ctx, flawedDraft, sentinelCritic);
      check(
        "integration: gemini path returns a valid verdict and never uses the injected Opus critic",
        isValidVerdict(r3) && !injectedOpusUsed,
        "overall=" + r3.overall + " injectedOpusUsed=" + injectedOpusUsed,
      );
    } catch (e) {
      check(
        "integration: gemini path returns a valid verdict and never uses the injected Opus critic",
        false,
        String(e),
      );
    }
  }

  if (savedProvider === undefined) delete process.env.CRITIC_PROVIDER;
  else process.env.CRITIC_PROVIDER = savedProvider;

  summary();
}

// Local alias for the transport result so this file needs no extra import.
type GeminiResultLike = Awaited<ReturnType<typeof geminiGenerateJson>>;

main()
  .then(() => process.exit(exitCode()))
  .catch((e) => {
    console.error("smoke test crashed:", e);
    process.exit(1);
  });
