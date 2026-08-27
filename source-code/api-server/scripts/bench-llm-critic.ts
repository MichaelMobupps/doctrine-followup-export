/**
 * bench-llm-critic.ts — head-to-head CRITIC quality + cost across candidate models.
 *
 * WHY THE CRITIC NEEDS ITS OWN BENCH
 *
 * bench-llm-quality.ts measures WRITING. Grading is a different job, and the
 * evidence says so: gemini-3-flash-preview scored 54.2% as a writer — near the
 * bottom of the field, at 3x the primary's price — while being the right model
 * to head the critic chain. A model chosen on writing scores would be the wrong
 * critic, and vice versa.
 *
 * It is also the role where cost is NOT the tie-breaker. In the live waterfall
 * smoke the critic was the single dearest call in the product ($0.0024 vs
 * $0.0001 for a draft), because it runs with thinking turned up. Whether that is
 * worth paying is exactly what this measures.
 *
 * WHAT IT MEASURES
 *
 * A battery of follow-up drafts, each planted with ONE doctrine violation of the
 * kind the deterministic linter CANNOT catch, plus clean controls. Two numbers
 * that pull in opposite directions:
 *
 *   RECALL     — of the planted-bad drafts, how many did the critic flag
 *                (needs_rewrite = true)? A miss ships a bad email.
 *   PRECISION  — of the clean drafts, how many did it correctly pass? A false
 *                flag costs a needless rewrite, which is real money and, worse,
 *                a re-roll of an email that was already fine.
 *
 * Plus NAMING: when it flags a planted fault, does it say WHAT the fault is?
 * The rewriter is driven by `issues`, so a critic that flags without naming
 * produces a rewrite that fixes the wrong thing.
 *
 * SAFE: no DB writes, no email, nothing on the production usage ledger.
 *
 * RUN (from artifacts/api-server):
 *   node --import tsx src/scripts/bench-llm-critic.ts
 *   node --import tsx src/scripts/bench-llm-critic.ts --models "gemini:gemini-3-flash-preview@MEDIUM,gemini:gemini-3-flash-preview@LOW"
 *   node --import tsx src/scripts/bench-llm-critic.ts --repeats 3
 *
 * Exit code: 0 always — this is a measurement, not a gate. Use
 * scripts/adversarial-critic.ts for the pass/fail gate on the live chain.
 */
import { geminiGenerateJson, type ThinkingLevel } from "../lib/gemini";
import { openaiGenerateJson, type ReasoningEffort } from "../lib/openai";
import { computeCostUsd } from "../lib/pricing";
import { parseChainSpec, type ModelTier } from "../lib/modelPolicy";
import { parseLlmJson } from "../lib/llmRouter";
import { GEMINI_CRITIC_FOCUS } from "../services/criticProvider";
import { getCriticSystemPrompt, getCriticUserPrompt, type FollowupContext } from "../services/followupPrompts";
import { UNTRUSTED_DATA_SYSTEM_CLAUSE } from "../lib/promptInjection";

const DEFAULT_MODELS = [
  "gemini:gemini-3-flash-preview@MEDIUM", // today's tier 1
  "gemini:gemini-3-flash-preview@LOW",    // is the thinking worth it?
  "gemini:gemini-3.1-flash-lite@LOW",     // could the cheap writer model grade?
  "openai:gpt-5.4-mini@low",              // today's tier 2
  "gemini:gemini-3.7-flash@LOW",          // today's tier 3
].join(",");

const ctx: FollowupContext = {
  prospect_name: "Alex",
  company: "Acme Mobile",
  vertical: "gaming_ua",
  sub_vertical: null,
  product: "performance user acquisition for mobile games",
  original_subject: "MobUpps for Acme Mobile UA",
  original_body_summary: "Intro to MobUpps performance UA with semi-exclusive supply and fraud filtering.",
  original_body:
    "Hi Alex, I am reaching out from MobUpps about performance user acquisition for your mobile games. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering and durable post-install retention.",
  original_language: "en",
  stage: 2,
  days_since_original: 4,
  sender_name: "Michael",
};

const SUBJECT = "Re: MobUpps for Acme Mobile UA";

interface Case {
  name: string;
  bad: boolean;
  subject: string;
  body: string;
  /** Lowercase substrings we hope to see named in `issues`. Wording varies, so a miss is a soft signal. */
  expect: string[];
}

// The planted faults are the SAME battery scripts/adversarial-critic.ts uses, so
// a number here is comparable with that gate's verdicts.
//
// Two clean controls, not one. Precision is the half of this measurement that a
// single control cannot resolve: with one control a model that flags everything
// scores 0% or 100% on a coin flip.
//
// THE CONTROLS ARE REAL PIPELINE OUTPUT, NOT HAND-WRITTEN, and that is the
// whole point. Two earlier versions of this bench hand-wrote them and both
// reported ~0% precision for every candidate — which read as "the critic flags
// everything" and would have been a wrong and expensive conclusion. Both times
// the critics were RIGHT and the fixture was wrong:
//
//   v1  single-line bodies, so every candidate correctly flagged
//       LAYOUT-GREETING-RUNON.
//   v2  greeting on its own line, but a 1+1+1 block shape and 3 sentences. The
//       doctrine prompt asks for a specific 1+3 shape and 4-6 sentences, and the
//       deterministic linter does NOT check that granularity — checking it is
//       precisely the critic's job. So the critics flagged it, correctly, and
//       the "clean" control was never clean.
//
// A control has to be clean by the rules the grader is actually applying, and
// the only reliable source of such a draft is the pipeline itself. These two
// came out of a real run of smoke-writer-heal-all-languages.ts and passed the
// full production gate. Regenerate them the same way if the doctrine prompt
// changes — do not hand-write replacements.
const cases: Case[] = [
  {
    name: "hype_adjectives",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, Following up on my note about UA for Acme Mobile. Our powerful platform delivers strong, best-in-class results across channels. Worth a quick test on a small segment?",
    expect: ["hype", "adjective", "powerful", "strong", "best-in-class"],
  },
  {
    name: "closing_signoff",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, Following up on my note about UA for Acme Mobile. We run CPI and CPA campaigns with fraud filtering. Worth a quick test on a small segment? Best regards, Michael",
    expect: ["closing", "sign-off", "sign off", "regards"],
  },
  {
    name: "meta_language",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, Following up on my previous email, citing competitor growth as urgency and referencing conversion benchmarks from comparable campaigns. Open to a quick test?",
    expect: ["meta", "describing", "citing", "referencing", "-ing"],
  },
  {
    name: "x_not_y_negation",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, Following up on my note about UA for Acme Mobile. We bring performance partners, not raw installs, with fraud filtering on top. Worth a quick test on a small segment?",
    expect: ["not", "contrast", "negation", "x-not-y"],
  },
  {
    name: "invented_statistic",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, Following up on my note about UA for Acme Mobile. Last quarter we drove around 250% growth for a similar studio. Worth a quick test on a small segment?",
    expect: ["statistic", "invented", "number", "250", "hedge", "around"],
  },
  {
    name: "no_followup_ack",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, MobUpps runs CPI and CPA campaigns with fraud filtering and durable retention for mobile gaming advertisers. Want to set up a quick call to explore a test?",
    expect: ["follow", "previous", "prior", "acknowledg", "cold", "first"],
  },
  {
    // A JUDGMENT fault, not a mechanical one: nothing here trips a regex, it is
    // simply a follow-up that adds no new angle and restates the first email.
    // This is precisely what the critic exists for, and what GEMINI_CRITIC_FOCUS
    // tells it to concentrate on.
    name: "no_new_angle",
    bad: true,
    subject: SUBJECT,
    body: "Hi Alex, Following up on my previous email about user acquisition for your mobile games. We run CPI and CPA campaigns on semi-exclusive supply with fraud filtering and durable post-install retention. Let me know if you are interested.",
    expect: ["angle", "new", "restat", "repeat", "same", "generic", "value"],
  },
  {
    // v4 control: generated by the live writer chain against THIS EXACT ctx and
    // verified STRUCTURALLY (no LLM in the loop) to match both the
    // deterministic ship gate AND the layout directive the critic judges
    // against — selectLayoutProfile seeds "tight-soft" (pattern [1,3], soft
    // break after sentence 1) from this ctx's (company, subject, stage), so a
    // control for a different ctx would be judged against a different shape.
    // The v3 controls were real pipeline output but matched only the ship
    // gate, not the directive, so the critics were STILL right to flag them
    // and the "25% precision" they produced was still partly fixture artifact.
    // Regenerate with scratchpad genctrl if the doctrine prompt or the layout
    // profiles change; never hand-write a replacement.
    name: "clean_control_1",
    bad: false,
    subject: SUBJECT,
    body: "Hi Alex,\n\nFollowing up on my note regarding the performance UA campaigns we run on semi-exclusive supply.\n\nWe see retention rates climb when moving traffic sources away from open exchanges into semi-exclusive placements.\nThis strategy builds a predictable D7 baseline for your gaming titles by filtering out low-quality inventory early. Is this worth a brief chat to compare against your current UA model?",
    expect: [],
  },
  {
    // Second v4 control, same generation + structural verification.
    name: "clean_control_2",
    bad: false,
    subject: SUBJECT,
    body: "Hi Alex,\n\nFollowing up on my note regarding the semi-exclusive supply we use for performance campaigns.\n\nMost UA spend leaks into broad inventory that provides little control over user persistence.\nWe focus on supply that remains semi-exclusive to ensure that retention metrics stay aligned with your long-term KPIs. Does it make sense to review a sample of our recent traffic sources for your genre?",
    expect: [],
  },
];

interface Verdict {
  needsRewrite: boolean;
  overall: number;
  issuesText: string;
  costUsd: number;
  ms: number;
  error?: string;
}

async function critique(tier: ModelTier, c: Case): Promise<Verdict> {
  const systemParts = [UNTRUSTED_DATA_SYSTEM_CLAUSE, getCriticSystemPrompt(), GEMINI_CRITIC_FOCUS];
  const user = getCriticUserPrompt(ctx, { subject: c.subject, body: c.body });
  const started = Date.now();
  try {
    let text: string;
    let inputTokens: number;
    let outputTokens: number;
    let cachedTokens: number;

    if (tier.provider === "gemini") {
      const res = await geminiGenerateJson({
        systemParts,
        user,
        model: tier.model,
        maxOutputTokens: 8192,
        thinkingLevel: tier.thinking as ThinkingLevel | undefined,
      });
      text = res.text;
      cachedTokens = res.usage.cachedContentTokenCount ?? 0;
      inputTokens = Math.max(0, (res.usage.promptTokenCount ?? 0) - cachedTokens);
      outputTokens = (res.usage.candidatesTokenCount ?? 0) + (res.usage.thoughtsTokenCount ?? 0);
    } else {
      const res = await openaiGenerateJson({
        systemParts,
        user,
        model: tier.model,
        maxOutputTokens: 8192,
        reasoningEffort: tier.effort as ReasoningEffort | undefined,
      });
      text = res.text;
      cachedTokens = res.usage.cachedPromptTokens ?? 0;
      inputTokens = Math.max(0, (res.usage.promptTokens ?? 0) - cachedTokens);
      outputTokens = res.usage.completionTokens ?? 0;
    }

    const parsed = parseLlmJson<{ needs_rewrite?: unknown; overall?: unknown; issues?: unknown }>(text);
    return {
      needsRewrite: parsed.needs_rewrite === true,
      overall: typeof parsed.overall === "number" ? parsed.overall : 5,
      issuesText: (Array.isArray(parsed.issues) ? parsed.issues.map(String) : []).join(" | ").toLowerCase(),
      costUsd: computeCostUsd(tier.model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens: cachedTokens,
      }),
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      needsRewrite: false,
      overall: 0,
      issuesText: "",
      costUsd: 0,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (f: string, d: string) => {
    const i = a.indexOf(f);
    return i >= 0 && a[i + 1] ? a[i + 1] : d;
  };
  return {
    models: get("--models", DEFAULT_MODELS),
    repeats: Math.max(1, Number(get("--repeats", "2"))),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const specs = opts.models.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = cases.filter((c) => c.bad).length;
  const clean = cases.length - bad;

  console.log("\nCritic quality + cost bench (LIVE — billed calls)");
  console.log(`models=${specs.length}  cases=${cases.length} (${bad} planted-bad, ${clean} clean)  repeats=${opts.repeats}\n`);

  interface Row {
    spec: string;
    caught: number;
    badTotal: number;
    named: number;
    falseFlags: number;
    cleanTotal: number;
    errors: number;
    cost: number;
    ms: number;
    missed: string[];
  }
  const rows: Row[] = [];
  let spend = 0;

  for (const spec of specs) {
    const parsed = parseChainSpec("bench", spec);
    if (parsed.length !== 1) throw new Error(`--models entry did not parse to one tier: "${spec}"`);
    const tier = parsed[0];
    const row: Row = {
      spec, caught: 0, badTotal: 0, named: 0, falseFlags: 0, cleanTotal: 0,
      errors: 0, cost: 0, ms: 0, missed: [],
    };
    process.stdout.write(`${spec.padEnd(40)} `);

    for (let rep = 0; rep < opts.repeats; rep++) {
      // Sequential, not parallel: the OpenAI account is 200k TPM and the critic
      // prompt is large. Racing them here produced 429s that looked like
      // quality failures in an earlier draft of this bench.
      for (const c of cases) {
        const v = await critique(tier, c);
        row.cost += v.costUsd;
        row.ms += v.ms;
        spend += v.costUsd;
        if (v.error) {
          row.errors++;
          process.stdout.write("!");
          continue;
        }
        if (c.bad) {
          row.badTotal++;
          if (v.needsRewrite) {
            row.caught++;
            if (c.expect.some((k) => v.issuesText.includes(k))) row.named++;
            process.stdout.write(".");
          } else {
            row.missed.push(c.name);
            process.stdout.write("x");
          }
        } else {
          row.cleanTotal++;
          if (v.needsRewrite) {
            row.falseFlags++;
            process.stdout.write("f");
          } else {
            process.stdout.write(".");
          }
        }
      }
    }
    process.stdout.write("\n");
    rows.push(row);
  }

  const calls = (r: Row) => r.badTotal + r.cleanTotal + r.errors;
  rows.sort((a, b) => {
    // Rank by recall first — a missed bad draft ships — then by precision.
    const ra = a.badTotal ? a.caught / a.badTotal : 0;
    const rb = b.badTotal ? b.caught / b.badTotal : 0;
    if (rb !== ra) return rb - ra;
    const pa = a.cleanTotal ? 1 - a.falseFlags / a.cleanTotal : 0;
    const pb = b.cleanTotal ? 1 - b.falseFlags / b.cleanTotal : 0;
    return pb - pa;
  });

  console.log("\n=== RESULTS (ranked by recall, then precision) ===\n");
  const head = [
    "model".padEnd(40),
    "recall".padStart(7),
    "named".padStart(6),
    "precis".padStart(7),
    "false".padStart(6),
    "err".padStart(4),
    "$/call".padStart(9),
    "ms".padStart(6),
  ].join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const r of rows) {
    const recall = r.badTotal ? (r.caught / r.badTotal) * 100 : 0;
    const named = r.caught ? (r.named / r.caught) * 100 : 0;
    const precision = r.cleanTotal ? (1 - r.falseFlags / r.cleanTotal) * 100 : 0;
    const n = calls(r) || 1;
    console.log(
      [
        r.spec.padEnd(40),
        recall.toFixed(0).padStart(6) + "%",
        named.toFixed(0).padStart(5) + "%",
        precision.toFixed(0).padStart(6) + "%",
        String(r.falseFlags).padStart(6),
        String(r.errors).padStart(4),
        (r.cost / n).toFixed(6).padStart(9),
        (r.ms / n).toFixed(0).padStart(6),
      ].join(" "),
    );
  }

  console.log("\nmissed planted faults (a miss ships a bad email):");
  for (const r of rows) {
    console.log(`  ${r.spec.padEnd(40)} ${r.missed.length ? [...new Set(r.missed)].join(", ") : "(none)"}`);
  }
  console.log(`\ntotal spend: $${spend.toFixed(4)}`);
  console.log(
    "\nreading this: recall is the safety number (a miss ships a bad email);\n" +
    "precision is the cost number (a false flag buys a needless rewrite);\n" +
    "'named' is whether a caught fault was described well enough for the\n" +
    "rewriter to fix the right thing — the rewriter is driven by `issues`.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
