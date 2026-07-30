/**
 * smoke-context-cheap-chain.ts — end-to-end validation of the sibling-flow cost
 * change. Drives the REAL generateContextFollowup (full heal loop, finalize) for
 * a sample of languages under TWO configs and compares the shipped-email clean
 * rate:
 *
 *   cheap : default routing — Gemini Flash writer -> Sonnet fallback, Gemini
 *           critic -> Sonnet fallback (the new money-saving path).
 *   sonnet: WRITER_PROVIDER=anthropic + CRITIC_PROVIDER=anthropic — the old
 *           all-Sonnet path, as a quality baseline.
 *
 * The context flow is non-sales, so NO doctrine exemplars are injected on either
 * path (that is the whole point — the writer chain still applies, just without
 * the study block). If the cheap clean rate tracks the Sonnet baseline, the
 * change holds quality.
 *
 * SAFE: bounded by --max-langs; each cell is up to 3 calls (draft, critic,
 * rewrite). Nothing is written to the production usage ledger (no usage context).
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-context-cheap-chain.ts
 *   node --import tsx src/scripts/smoke-context-cheap-chain.ts --langs en,de,ja,ar
 *
 * Exit codes: 0 cheap held quality (clean rate within 15 pts of Sonnet) and no
 * errors; 1 a hard error or a material quality regression.
 */
import { generateContextFollowup } from "../services/contextFollowupGenerator";
import type { FollowupContext } from "../services/followupPrompts";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { isGeminiConfigured } from "../lib/gemini";
import { logger } from "../lib/logger";

const DEFAULT_LANGS = ["en", "de", "fr", "es", "ja", "ar", "hi", "ru", "tr", "pt-BR"];
const DELTA_TOLERANCE_PCT = 15;

function buildCtx(lang: string): FollowupContext {
  return {
    prospect_name: "Alex",
    company: "Lumi Health App",
    vertical: "non_gaming_ua",
    sub_vertical: null,
    product: "performance user acquisition for your app",
    original_subject: "Quick question on the Q3 UA test",
    original_body_summary:
      "Earlier email asking whether they had a chance to look at the proposed Q3 user-acquisition test plan and if the timing works.",
    original_body:
      "Hi Alex, following our last call I sent over a short Q3 user-acquisition test plan for Lumi Health App. Wanted to check whether you had a chance to look it over and if the timing works on your side. Happy to adjust the scope.",
    original_language: lang,
    stage: 2,
    days_since_original: 4,
    sender_name: "Michael",
    previous_followups: [],
  } as FollowupContext;
}

// Verdict on the context flow's OWN heal gate — detectAllDeterministicViolations
// — exactly what generateContextFollowup enforces in its rewrite loop. The
// doctrine structural lint (FOLLOWUP-ACK, VERBATIM-OVERLAP) is deliberately NOT
// included: the context flow never heals against it and it is false-positive
// prone without the dropFalseFollowupAck LLM guard, so it would flag both models
// uniformly and tell us nothing about the cheap-vs-Sonnet delta.
function lintBody(body: string, ctx: FollowupContext): { pass: boolean; issues: string[] } {
  const report = detectAllDeterministicViolations(body, ctx.original_language);
  return { pass: !report.found, issues: report.issues.slice(0, 4) };
}

function parseArgs() {
  const a = process.argv.slice(2);
  const i = a.indexOf("--langs");
  const langs = i >= 0 && a[i + 1] ? a[i + 1].split(",").map((s) => s.trim()) : DEFAULT_LANGS;
  return { langs };
}

type Verdict = "PASS" | "FAIL" | "ERROR";
interface Cell { lang: string; verdict: Verdict; issues: string[] }

async function runConfig(config: "cheap" | "sonnet", langs: string[]): Promise<Cell[]> {
  if (config === "sonnet") {
    process.env.WRITER_PROVIDER = "anthropic";
    process.env.CRITIC_PROVIDER = "anthropic";
  } else {
    delete process.env.WRITER_PROVIDER; // default -> gemini
    process.env.CRITIC_PROVIDER = "gemini"; // default cheap critic
  }
  const out: Cell[] = [];
  for (const lang of langs) {
    const ctx = buildCtx(lang);
    try {
      const res = await generateContextFollowup(ctx);
      const lint = lintBody(res.body, ctx);
      out.push({ lang, verdict: lint.pass ? "PASS" : "FAIL", issues: lint.issues });
      console.log(`  ${config.padEnd(6)} ${lang.padEnd(6)} ${lint.pass ? "PASS" : "FAIL"}${lint.issues.length ? `  ${lint.issues.join(" | ")}` : ""}`);
    } catch (err) {
      out.push({ lang, verdict: "ERROR", issues: [err instanceof Error ? err.message : String(err)] });
      console.log(`  ${config.padEnd(6)} ${lang.padEnd(6)} ERROR  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

function cleanRate(cells: Cell[]): { clean: number; graded: number; pct: number } {
  const graded = cells.filter((c) => c.verdict !== "ERROR");
  const clean = graded.filter((c) => c.verdict === "PASS").length;
  return { clean, graded: graded.length, pct: graded.length ? (100 * clean) / graded.length : 0 };
}

async function main() {
  // Quiet the generators' info logs so the smoke output stays readable.
  (logger as unknown as { level: string }).level = "warn";
  const { langs } = parseArgs();
  if (!isGeminiConfigured()) {
    console.error("GEMINI_API_KEY is not set — cannot exercise the cheap chain. Aborting.");
    process.exit(1);
  }
  console.log(`\nContext-flow cheap-chain smoke — ${langs.length} languages, real generateContextFollowup end-to-end\n`);

  console.log("CHEAP (Gemini Flash writer + Gemini critic, Sonnet fallbacks):");
  const cheap = await runConfig("cheap", langs);
  console.log("\nSONNET baseline (WRITER_PROVIDER=anthropic + CRITIC_PROVIDER=anthropic):");
  const sonnet = await runConfig("sonnet", langs);

  const c = cleanRate(cheap);
  const s = cleanRate(sonnet);
  const delta = s.pct - c.pct; // positive => Sonnet cleaner => cheap costs quality
  const errs = [...cheap, ...sonnet].filter((x) => x.verdict === "ERROR");

  console.log(`\n${"-".repeat(60)}`);
  console.log(`CHEAP  clean: ${c.clean}/${c.graded}  (${c.pct.toFixed(1)}%)`);
  console.log(`SONNET clean: ${s.clean}/${s.graded}  (${s.pct.toFixed(1)}%)`);
  console.log(`delta (Sonnet - cheap): ${delta.toFixed(1)} pts   tolerance: ${DELTA_TOLERANCE_PCT} pts`);
  if (errs.length) console.log(`errors: ${errs.map((e) => e.lang).join(", ")}`);

  const hardError = errs.length > 0;
  const qualityRisk = delta > DELTA_TOLERANCE_PCT;
  const verdict = hardError
    ? "SMOKE FAIL (errors)"
    : qualityRisk
    ? `SMOKE FAIL — cheap ${delta.toFixed(1)} pts worse than Sonnet`
    : `SMOKE PASS — cheap chain holds context-flow quality (within ${DELTA_TOLERANCE_PCT} pts)`;
  console.log(`\n${verdict}\n`);
  process.exit(hardError || qualityRisk ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
