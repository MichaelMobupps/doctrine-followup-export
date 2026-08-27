/**
 * bench-llm-pipeline.ts — what a follow-up ACTUALLY costs, critic included.
 *
 * WHY THIS EXISTS, AND WHAT IT CORRECTS
 *
 * `smoke-writer-heal-all-languages.ts` measures the writer stages: draft ->
 * deterministic lint -> rewrite -> lint. It never calls the LLM critic, because
 * it deliberately replicates the *deterministic* heal loop. That makes it the
 * right tool for comparing writer chains — and the wrong tool for costing
 * production, which runs the critic on every deterministically-clean draft and
 * rewrites again whenever the critic says so.
 *
 * A cost figure from that harness is therefore a FLOOR, not the bill. This
 * bench drives the real `generateFollowupEmail()` — the same function the
 * scheduler calls, with the critic, the ack-confirm guard, the humanizer, all
 * of it — and totals every billed LLM call underneath via the router's
 * diagnostics observer.
 *
 * It reports, per language: the shipped email's clean verdict, the number of
 * LLM calls it took, the cost, and the per-role split. The per-role split is
 * the interesting column: it shows how much of the bill the critic stage is,
 * which is the question the writer harness cannot answer.
 *
 * SAFE: the bench runs outside runWithUsageContext, so the pipeline recorders
 * no-op — and the AUX recorder (ack-confirm rows, which write without a
 * context by design) is switched off for this process via
 * __setLedgerSuppressedForOfflineRuns, so NOTHING reaches the followup_usage
 * ledger. The first version of this header claimed that without the switch,
 * and was wrong: four ack_confirm rows per run were landing on the production
 * ledger. The observer is a local, in-process callback.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/bench-llm-pipeline.ts
 *   node --import tsx src/scripts/bench-llm-pipeline.ts --langs en,de,ja,ar --verticals gaming_ua
 *
 * Exit codes: 0 the run completed; 1 a hard error.
 */
import { generateFollowupEmail } from "../services/followupGenerator";
import { __setLedgerSuppressedForOfflineRuns } from "../lib/usageTracker";
import { setLlmCallObserver, type LlmCallObservation } from "../lib/llmRouter";
import { computeCostUsd } from "../lib/pricing";
import type { FollowupContext } from "../services/followupPrompts";
import { detectAllDeterministicViolations } from "../lib/doctrineLint";
import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";
import { logger } from "../lib/logger";

const DEFAULT_LANGS = ["en", "es", "de", "tr", "ru", "ja", "zh", "ar", "he", "hi"];

function buildCtx(lang: string, vertical: string): FollowupContext {
  const gaming = vertical === "gaming_ua";
  return {
    prospect_name: "Alex",
    company: gaming ? "PixelForge Games" : "ShopNova",
    vertical,
    sub_vertical: null,
    product: gaming
      ? "performance user acquisition for mobile games"
      : "CPS and revenue-share performance partnership",
    original_subject: gaming ? "MobUpps UA for PixelForge Games" : "MobUpps CPS partnership for ShopNova",
    original_body_summary: gaming
      ? "Intro to MobUpps performance UA for mobile games with semi-exclusive supply and fraud filtering."
      : "Intro to a CPS / revenue-share performance partnership with verified-sale tracking.",
    original_body: gaming
      ? "Hi Alex, I am reaching out from MobUpps about performance user acquisition for your mobile games. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering and durable post-install retention."
      : "Hi Alex, I am reaching out from MobUpps about a CPS partnership for ShopNova. We work on a revenue-share basis with verified-sale tracking and fraud filtering, so you pay against confirmed outcomes.",
    original_language: lang,
    stage: 2,
    days_since_original: 4,
    sender_name: "Michael",
  };
}

function lintShipped(body: string, ctx: FollowupContext): { pass: boolean; issues: string[] } {
  const src = [ctx.original_subject, ctx.original_body, ctx.original_body_summary].join("\n");
  const report = mergeViolationReports(
    detectAllDeterministicViolations(body, ctx.original_language),
    detectStructuralViolations(body, {
      languageTag: ctx.original_language,
      originalText: src,
      companyName: ctx.company,
    }),
  );
  return { pass: !report.found, issues: report.issues.slice(0, 2) };
}

function costOf(o: LlmCallObservation): number {
  return computeCostUsd(o.model, {
    inputTokens: o.usage.inputTokens,
    outputTokens: o.usage.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: o.usage.cachedInputTokens,
  });
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d: string) => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] ? a[i + 1] : d;
  };
  return {
    langs: get("--langs", DEFAULT_LANGS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    verticals: get("--verticals", "gaming_ua,cps").split(",").map((s) => s.trim()).filter(Boolean),
    baselineModel: get("--baseline-model", "claude-sonnet-4-6"),
  };
}

interface Cell {
  lang: string;
  vertical: string;
  ok: boolean;
  issues: string[];
  calls: number;
  cost: number;
  baseline: number;
  byRole: Map<string, { calls: number; cost: number }>;
  error?: string;
}

async function main(): Promise<void> {
  (logger as unknown as { level: string }).level = "warn";
  __setLedgerSuppressedForOfflineRuns(true);
  const opts = parseArgs();
  const cells: Cell[] = [];

  console.log("\nFULL-pipeline bench — real generateFollowupEmail(), critic included (LIVE, billed)");
  console.log(`langs=${opts.langs.length}  verticals=${opts.verticals.join(",")}\n`);

  for (const lang of opts.langs) {
    for (const vertical of opts.verticals) {
      const ctx = buildCtx(lang, vertical);
      const seen: LlmCallObservation[] = [];
      setLlmCallObserver((o) => seen.push(o));
      let cell: Cell;
      try {
        const out = await generateFollowupEmail(ctx);
        const lint = lintShipped(out.body, ctx);
        cell = {
          lang, vertical, ok: lint.pass, issues: lint.issues,
          calls: seen.length,
          cost: seen.reduce((s, o) => s + costOf(o), 0),
          baseline: seen.reduce(
            (s, o) =>
              s +
              computeCostUsd(opts.baselineModel, {
                inputTokens: o.usage.inputTokens,
                outputTokens: o.usage.outputTokens,
                cacheCreationTokens: 0,
                cacheReadTokens: o.usage.cachedInputTokens,
              }),
            0,
          ),
          byRole: new Map(),
        };
        for (const o of seen) {
          const r = cell.byRole.get(o.role) ?? { calls: 0, cost: 0 };
          r.calls++;
          r.cost += costOf(o);
          cell.byRole.set(o.role, r);
        }
      } catch (err) {
        cell = {
          lang, vertical, ok: false, issues: [],
          calls: seen.length, cost: seen.reduce((s, o) => s + costOf(o), 0), baseline: 0,
          byRole: new Map(), error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        setLlmCallObserver(null);
      }
      cells.push(cell);
      const roles = [...cell.byRole.entries()].map(([r, v]) => `${r}x${v.calls}`).join(" ");
      console.log(
        `  ${(cell.lang + "/" + cell.vertical).padEnd(20)} ${cell.error ? "ERROR" : cell.ok ? "CLEAN" : "DIRTY"}  ` +
          `${String(cell.calls).padStart(2)} calls  $${cell.cost.toFixed(6)}  ${roles}` +
          (cell.error ? `  ${cell.error.slice(0, 80)}` : cell.issues.length ? `  ${cell.issues[0].slice(0, 70)}` : ""),
      );
    }
  }

  const graded = cells.filter((c) => !c.error);
  const clean = graded.filter((c) => c.ok).length;
  const totalCost = cells.reduce((s, c) => s + c.cost, 0);
  const totalBaseline = cells.reduce((s, c) => s + c.baseline, 0);
  const totalCalls = cells.reduce((s, c) => s + c.calls, 0);

  const roleAgg = new Map<string, { calls: number; cost: number }>();
  for (const c of cells) {
    for (const [role, v] of c.byRole) {
      const a = roleAgg.get(role) ?? { calls: 0, cost: 0 };
      a.calls += v.calls;
      a.cost += v.cost;
      roleAgg.set(role, a);
    }
  }

  console.log(`\n${"-".repeat(70)}`);
  console.log(`cells: ${cells.length}   ships clean: ${clean}/${graded.length}   errors: ${cells.length - graded.length}`);
  console.log(`LLM calls: ${totalCalls}  (${(totalCalls / Math.max(1, cells.length)).toFixed(2)} per follow-up)`);
  console.log(`total: $${totalCost.toFixed(4)}   per SHIPPED email: $${(clean ? totalCost / clean : 0).toFixed(6)}`);
  console.log(
    `same tokens on ${opts.baselineModel}: $${totalBaseline.toFixed(4)}` +
      (totalBaseline > 0 ? `   => ${((1 - totalCost / totalBaseline) * 100).toFixed(1)}% cheaper` : ""),
  );
  console.log(`\nby role (this is the column the writer-only harness cannot show):`);
  for (const [role, a] of [...roleAgg.entries()].sort((x, y) => y[1].cost - x[1].cost)) {
    const share = totalCost > 0 ? (a.cost / totalCost) * 100 : 0;
    console.log(
      `  ${role.padEnd(16)} ${String(a.calls).padStart(3)} calls  $${a.cost.toFixed(6)}  ${share.toFixed(1)}% of spend`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
