/**
 * Smoke test for the Gemini critic patch.
 *
 * This is an on-demand diagnostic, not part of the auto-run suite, because it
 * makes a live billed call to Gemini and needs GEMINI_API_KEY. It lives under
 * src/scripts/ so `node --test src/tests/*.ts` never picks it up.
 *
 * What it verifies, fastest checks first:
 *   1. The gemini-3.5-flash price row landed in the pricing table.
 *   2. CRITIC_PROVIDER routing: default is anthropic; anthropic mode uses the
 *      Anthropic critic; gemini mode with no key falls back to Anthropic.
 *   3. Live transport: a real Gemini 3.5 Flash call returns parseable JSON,
 *      the verdict has the correct shape, and usage and cost are reported.
 *   4. Integration: runCritic in gemini mode returns a valid verdict without
 *      falling back to Anthropic.
 *
 * Run from artifacts/api-server, where DATABASE_URL and GEMINI_API_KEY are set:
 *   node --import tsx src/scripts/smoke-critic.ts
 *
 * Optional depth override for the live call:
 *   GEMINI_CRITIC_THINKING=HIGH node --import tsx src/scripts/smoke-critic.ts
 *
 * Exit code is 0 when every check passes, 1 otherwise. Warnings do not fail
 * the run; they flag verdict content that looks off and is worth an eyeball.
 */
import { runCritic, getCriticProvider } from "../services/criticProvider";
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
import { computeCostUsd, getModelPrice } from "../lib/pricing";
import type { CriticResult } from "../services/followupGenerator";

let passed = 0;
let failed = 0;
let warned = 0;

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

// Fixed English context so nativeness rules stay quiet and the verdict is
// easy to reason about. English avoids the non-Latin script criteria.
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

// Deliberately flawed draft: it carries a closing sign-off (criterion 15, a
// blocking rule) and hype adjectives (doctrine). A sound critic should set
// needs_rewrite = true. The smoke test treats a miss here as a warning rather
// than a failure, since model judgement varies.
const flawedDraft = {
  subject: "Re: MobUpps for Acme Mobile UA",
  body:
    "Hi Alex, Following up on my note about UA for Acme Mobile. Our powerful platform drives strong results across channels. Worth a quick test on a small segment? Best regards, Michael",
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

// Same tolerant extraction the critic provider uses.
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

function summary(): void {
  const verdict = failed === 0 ? "SMOKE PASS" : "SMOKE FAIL";
  console.log(
    "\n=== " +
      verdict +
      " : " +
      passed +
      " passed, " +
      failed +
      " failed, " +
      warned +
      " warnings ===",
  );
}

async function main(): Promise<void> {
  console.log("=== Gemini critic smoke test ===\n");

  // 1. Pricing patch landed.
  const price = getModelPrice(GEMINI_CRITIC_MODEL);
  check(
    "pricing: gemini-3.5-flash row present",
    price.input === 1.5 && price.output === 9,
    "input=" + price.input + " output=" + price.output,
  );

  // 2. Routing and fallback (no network).
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
  check("routing: default provider is anthropic", getCriticProvider() === "anthropic");

  process.env.CRITIC_PROVIDER = "anthropic";
  stubCalled = false;
  const r1 = await runCritic(ctx, flawedDraft, stub);
  check(
    "routing: anthropic mode calls the Anthropic critic",
    stubCalled && r1.overall === 4,
  );

  delete process.env.GEMINI_API_KEY;
  process.env.CRITIC_PROVIDER = "gemini";
  stubCalled = false;
  const r2 = await runCritic(ctx, flawedDraft, stub);
  check(
    "routing: gemini mode with no key falls back to Anthropic",
    stubCalled && r2.overall === 4,
  );
  if (savedKey) process.env.GEMINI_API_KEY = savedKey;

  // 3. Live Gemini transport, shape, usage, cost.
  if (!isGeminiConfigured()) {
    failed++;
    console.log(
      "\n  FAIL  live: GEMINI_API_KEY is not set, cannot smoke-test the Gemini path",
    );
    if (savedProvider === undefined) delete process.env.CRITIC_PROVIDER;
    else process.env.CRITIC_PROVIDER = savedProvider;
    summary();
    process.exit(1);
  }

  console.log("\n[live] calling " + GEMINI_CRITIC_MODEL + " via geminiGenerateJson ...");
  const t0 = Date.now();
  const res = await geminiGenerateJson({
    systemParts: [UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt()],
    user: getCriticUserPrompt(ctx, flawedDraft),
    maxOutputTokens: 8192,
  });
  const ms = Date.now() - t0;

  check(
    "live: Gemini returned text",
    res.text.length > 0,
    res.text.length + " chars in " + ms + "ms",
  );
  check("live: model is gemini-3.5-flash", res.model === GEMINI_CRITIC_MODEL, res.model);

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
        "live: flawed draft was not flagged, expected needs_rewrite=true",
        "eyeball the verdict below",
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

  // 4. Live integration through the real switch, proving no fallback.
  process.env.CRITIC_PROVIDER = "gemini";
  const throwingStub = async (): Promise<CriticResult> => {
    throw new Error("Anthropic fallback was used, the Gemini path did not succeed");
  };
  try {
    const r3 = await runCritic(ctx, flawedDraft, throwingStub);
    check(
      "integration: runCritic gemini path returns a valid verdict without fallback",
      isValidVerdict(r3),
      "overall=" + r3.overall,
    );
  } catch (e) {
    check(
      "integration: runCritic gemini path returns a valid verdict without fallback",
      false,
      String(e),
    );
  }

  if (savedProvider === undefined) delete process.env.CRITIC_PROVIDER;
  else process.env.CRITIC_PROVIDER = savedProvider;

  summary();
}

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((e) => {
    console.error("smoke test crashed:", e);
    process.exit(1);
  });
