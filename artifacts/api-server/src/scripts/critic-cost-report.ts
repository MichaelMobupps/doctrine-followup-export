/**
 * Read-only cost report for the follow-up pipeline.
 *
 * Aggregates the followup_usage ledger over a recent window, shows the
 * per-stage and per-model cost split, and reprices the critic stage at the
 * candidate Gemini models so you can see the real per-follow-up saving rather
 * than an estimate.
 *
 * This script only runs SELECT queries. It never writes.
 *
 * Run from artifacts/api-server with DATABASE_URL in scope:
 *   node --import tsx src/scripts/critic-cost-report.ts
 *
 * Optional:
 *   ANALYZE_DAYS=30      window in days (default 30)
 *   ANALYZE_APP=doctrine which flow to analyze (default doctrine)
 */
import { db, followupUsageTable } from "@workspace/db";
import { and, gte, eq } from "drizzle-orm";
import { MODEL_PRICES } from "../lib/pricing";

interface Rate {
  name: string;
  input: number; // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

// Candidate critic models to reprice against. Rates come from the shared
// pricing table so this report can never drift from what the ledger bills —
// the hardcoded copy it used to carry went stale the first time a price moved.
// Output rate covers visible answer tokens plus thinking tokens, which is
// where critic cost concentrates.
const CANDIDATE_NAMES = [
  "gemini-3-flash-preview",
  "gpt-5.4-mini",
  "gemini-3.7-flash",
  "gemini-3.1-flash-lite",
] as const;

const CANDIDATES: Rate[] = CANDIDATE_NAMES.map((name) => {
  const price = MODEL_PRICES[name];
  if (!price) throw new Error(`candidate ${name} is missing from MODEL_PRICES`);
  return { name, input: price.input, output: price.output };
});

function usd(n: number): string {
  return "$" + n.toFixed(6);
}
function pct(n: number): string {
  return n.toFixed(1) + "%";
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

interface Agg {
  calls: number;
  input: number;
  output: number;
  cost: number;
  models: Set<string>;
}

function newAgg(): Agg {
  return { calls: 0, input: 0, output: 0, cost: 0, models: new Set<string>() };
}

async function main(): Promise<void> {
  const days = Number(process.env.ANALYZE_DAYS) > 0 ? Number(process.env.ANALYZE_DAYS) : 30;
  const app = process.env.ANALYZE_APP || "doctrine";
  const since = new Date(Date.now() - days * 86_400_000);

  console.log("=== Follow-up cost report ===");
  console.log("app: " + app + "   window: last " + days + " days   since: " + since.toISOString());
  console.log("");

  const rows = await db
    .select()
    .from(followupUsageTable)
    .where(and(gte(followupUsageTable.generatedAt, since), eq(followupUsageTable.app, app)))
    .limit(100000);

  if (rows.length === 0) {
    console.log("No usage rows in this window. Widen ANALYZE_DAYS or check ANALYZE_APP.");
    process.exit(0);
  }

  const followups = new Set<number>();
  const byLabel = new Map<string, Agg>();
  const byModel = new Map<string, Agg>();
  let totalCost = 0;

  for (const r of rows) {
    const cost = Number(r.costUsd) || 0;
    totalCost += cost;
    if (r.followupId != null) followups.add(r.followupId);

    const lab = byLabel.get(r.label) ?? newAgg();
    lab.calls += 1;
    lab.input += r.inputTokens;
    lab.output += r.outputTokens;
    lab.cost += cost;
    lab.models.add(r.model);
    byLabel.set(r.label, lab);

    const mod = byModel.get(r.model) ?? newAgg();
    mod.calls += 1;
    mod.input += r.inputTokens;
    mod.output += r.outputTokens;
    mod.cost += cost;
    byModel.set(r.model, mod);
  }

  const nFollowups = followups.size || 1;
  const avgPerFollowup = totalCost / nFollowups;

  console.log(
    "rows: " + rows.length + "   distinct follow-ups: " + followups.size + "   total cost: " + usd(totalCost),
  );
  console.log("average cost per follow-up: " + usd(avgPerFollowup));
  console.log("");

  // Per-stage breakdown, sorted by cost share descending.
  console.log("By stage (label):");
  console.log(
    "  " + pad("label", 22) + pad("calls", 8) + pad("calls/fu", 10) + pad("$ total", 14) + pad("% total", 10) + "$/follow-up",
  );
  const labelsSorted = [...byLabel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [label, a] of labelsSorted) {
    const share = totalCost > 0 ? (a.cost / totalCost) * 100 : 0;
    console.log(
      "  " +
        pad(label, 22) +
        pad(String(a.calls), 8) +
        pad((a.calls / nFollowups).toFixed(2), 10) +
        pad(usd(a.cost), 14) +
        pad(pct(share), 10) +
        usd(a.cost / nFollowups),
    );
  }
  console.log("");

  console.log("By model:");
  const modelsSorted = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [model, a] of modelsSorted) {
    const share = totalCost > 0 ? (a.cost / totalCost) * 100 : 0;
    console.log("  " + pad(model, 26) + pad(String(a.calls) + " calls", 12) + pad(usd(a.cost), 14) + pct(share));
  }
  console.log("");

  // Critic repricing. Sum every label that contains "critic".
  const critic = newAgg();
  for (const [label, a] of byLabel.entries()) {
    if (label.toLowerCase().includes("critic")) {
      critic.calls += a.calls;
      critic.input += a.input;
      critic.output += a.output;
      critic.cost += a.cost;
      a.models.forEach((m) => critic.models.add(m));
    }
  }

  if (critic.calls === 0) {
    console.log("No critic-labelled rows found in this window, so no repricing to show.");
    process.exit(0);
  }

  const criticPerFollowupNow = critic.cost / nFollowups;
  const criticShare = totalCost > 0 ? (critic.cost / totalCost) * 100 : 0;

  console.log("Critic stage today:");
  console.log("  models: " + [...critic.models].join(", "));
  console.log(
    "  calls: " +
      critic.calls +
      " (" +
      (critic.calls / nFollowups).toFixed(2) +
      " per follow-up), input tokens: " +
      critic.input +
      ", output+thinking tokens: " +
      critic.output,
  );
  console.log("  cost: " + usd(critic.cost) + " (" + pct(criticShare) + " of pipeline)");
  console.log("  critic cost per follow-up: " + usd(criticPerFollowupNow));
  console.log("");

  console.log("Repriced critic (same token volume, candidate rates):");
  console.log(
    "  " + pad("model", 26) + pad("$/follow-up", 16) + pad("new total/fu", 16) + "reduction",
  );
  for (const c of CANDIDATES) {
    const projectedCost = (critic.input * c.input + critic.output * c.output) / 1_000_000;
    const projectedPerFollowup = projectedCost / nFollowups;
    const newTotal = avgPerFollowup - criticPerFollowupNow + projectedPerFollowup;
    const reduction = avgPerFollowup > 0 ? ((avgPerFollowup - newTotal) / avgPerFollowup) * 100 : 0;
    console.log(
      "  " +
        pad(c.name, 26) +
        pad(usd(projectedPerFollowup), 16) +
        pad(usd(newTotal), 16) +
        pct(reduction) + " off total",
    );
  }
  console.log("");
  console.log(
    "Note: repricing applies each model's rate to the critic's recorded token",
  );
  console.log(
    "volume. A different model thinks a different amount, so the live shadow run",
  );
  console.log("gives the exact figure. This is your real data, not a flat estimate.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("cost report failed:", e);
    process.exit(1);
  });
