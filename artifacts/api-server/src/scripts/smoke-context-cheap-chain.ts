/**
 * smoke-context-cheap-chain.ts — end-to-end ship-clean smoke for the CONTEXT
 * flow, the exemplar-less pipeline that historically regressed first on cheap
 * writers.
 *
 * Drives the REAL generateContextFollowup (draft -> critic -> rewrite ->
 * finalize) across a language sample and lints what would actually ship. This
 * flow has no exemplar library, which is exactly why it runs its own, stronger
 * chain (EXEMPLARLESS_WRITER_CHAIN in lib/modelPolicy.ts) — and why it needs
 * its own end-to-end smoke: the doctrine-flow E2E cannot vouch for it.
 *
 * Aug 2026: this used to be a cheap-vs-Sonnet A/B driven by WRITER_PROVIDER /
 * CRITIC_PROVIDER. Those switches no longer exist (Anthropic is disabled and
 * routing lives in lib/modelPolicy.ts), and for a while after the migration the
 * "sonnet" arm silently ran the identical config as the "cheap" arm, making the
 * comparison pass vacuously. A smoke that cannot fail is worse than none, so
 * the dead arm is gone: this is now a single-config gate on the live chain with
 * an ABSOLUTE clean-rate floor instead of a delta against a baseline that can
 * no longer be produced.
 *
 * SAFE: each cell is up to 3 calls (draft, critic, rewrite). Nothing is written
 * to the production usage ledger (no usage context).
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/smoke-context-cheap-chain.ts
 *   node --import tsx src/scripts/smoke-context-cheap-chain.ts --langs en,de,ja,ar
 *
 * Exit codes: 0 clean rate >= the floor and no errors; 1 a hard error or a
 * clean rate below the floor.
 */
import { generateContextFollowup } from "../services/contextFollowupGenerator";
import type { FollowupContext } from "../services/followupPrompts";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { isGeminiConfigured } from "../lib/gemini";
import { logger } from "../lib/logger";

const DEFAULT_LANGS = ["en", "de", "fr", "es", "ja", "ar", "hi", "ru", "tr", "pt-BR"];
// Absolute gate. The pre-migration cheap-vs-Sonnet runs recorded the exemplar-
// less flow at 50% clean on the cheap writer vs 80% on Sonnet; the stronger
// chain exists to close that gap, so the floor sits at the old Sonnet-era
// neighbourhood minus one cell of noise on a 10-language sample.
const MIN_CLEAN_PCT = 70;

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

async function runAll(langs: string[]): Promise<Cell[]> {
  const out: Cell[] = [];
  for (const lang of langs) {
    const ctx = buildCtx(lang);
    try {
      const res = await generateContextFollowup(ctx);
      const lint = lintBody(res.body, ctx);
      out.push({ lang, verdict: lint.pass ? "PASS" : "FAIL", issues: lint.issues });
      console.log(`  ${lang.padEnd(6)} ${lint.pass ? "PASS" : "FAIL"}${lint.issues.length ? `  ${lint.issues.join(" | ")}` : ""}`);
    } catch (err) {
      out.push({ lang, verdict: "ERROR", issues: [err instanceof Error ? err.message : String(err)] });
      console.log(`  ${lang.padEnd(6)} ERROR  ${err instanceof Error ? err.message : String(err)}`);
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
  console.log(`\nContext-flow ship-clean smoke — ${langs.length} languages, real generateContextFollowup end-to-end\n`);

  const cells = await runAll(langs);

  const c = cleanRate(cells);
  const errs = cells.filter((x) => x.verdict === "ERROR");

  console.log(`\n${"-".repeat(60)}`);
  console.log(`clean: ${c.clean}/${c.graded}  (${c.pct.toFixed(1)}%)   floor: ${MIN_CLEAN_PCT}%`);
  if (errs.length) console.log(`errors: ${errs.map((e) => e.lang).join(", ")}`);

  const hardError = errs.length > 0;
  const qualityRisk = c.pct < MIN_CLEAN_PCT;
  const verdict = hardError
    ? "SMOKE FAIL (errors)"
    : qualityRisk
    ? `SMOKE FAIL — clean rate ${c.pct.toFixed(1)}% is below the ${MIN_CLEAN_PCT}% floor`
    : `SMOKE PASS — context flow ships clean (${c.clean}/${c.graded})`;
  console.log(`\n${verdict}\n`);
  process.exit(hardError || qualityRisk ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
