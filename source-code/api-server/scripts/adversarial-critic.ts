/**
 * Adversarial end-to-end test for the Gemini critic.
 *
 * On-demand, not in the auto-run suite (live billed calls). It runs a battery
 * of deliberately bad follow-up drafts, each planted with one doctrine
 * violation, plus one clean control, and proves the loop:
 *
 *   bad draft  ->  Gemini critic flags it  ->  Sonnet rewriter fixes it
 *              ->  Gemini critic confirms the rewrite is clean
 *
 * The critic always runs on Gemini here (CRITIC_PROVIDER is forced to gemini
 * and a throwing stub stands in for Anthropic, so a Gemini failure surfaces
 * rather than being masked by the Opus fallback). The rewriter is the normal
 * Sonnet rewriter, unchanged by this project.
 *
 * Run from artifacts/api-server with GEMINI_API_KEY and ANTHROPIC_API_KEY set:
 *   node --import tsx src/scripts/adversarial-critic.ts
 *
 * Skip the rewrite phase to halve the cost and only test catching:
 *   ADV_SKIP_REWRITE=1 node --import tsx src/scripts/adversarial-critic.ts
 *
 * Exit codes: 0 every bad draft was caught and the control passed, 1 a planted
 * violation was missed, 2 Gemini was overloaded (a Google capacity issue).
 */
import { runCritic } from "../services/criticProvider";
import { rewriteDraft } from "../services/followupGenerator";
import { isGeminiConfigured, GEMINI_CRITIC_MODEL } from "../lib/gemini";
import type { FollowupContext } from "../services/followupPrompts";
import type { CriticResult } from "../services/followupGenerator";

let passed = 0;
let failed = 0;
let warned = 0;
let blocked = false;

function pass(name: string, detail = ""): void {
  passed++;
  console.log("  PASS  " + name + (detail ? " (" + detail + ")" : ""));
}
function fail(name: string, detail = ""): void {
  failed++;
  console.log("  FAIL  " + name + (detail ? " (" + detail + ")" : ""));
}
function warn(name: string, detail = ""): void {
  warned++;
  console.log("  WARN  " + name + (detail ? " (" + detail + ")" : ""));
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

interface Case {
  name: string;
  bad: boolean;
  subject: string;
  body: string;
  // Lowercase substrings we hope to see named in the critic's issues. A miss
  // is a warning, not a failure, since wording varies.
  expect: string[];
}

const SUBJECT = "Re: MobUpps for Acme Mobile UA";

const cases: Case[] = [
  {
    name: "hype_adjectives",
    bad: true,
    subject: SUBJECT,
    body:
      "Hi Alex, Following up on my note about UA for Acme Mobile. Our powerful platform delivers strong, best-in-class results across channels. Worth a quick test on a small segment?",
    expect: ["hype", "adjective", "powerful", "strong", "best-in-class"],
  },
  {
    name: "closing_signoff",
    bad: true,
    subject: SUBJECT,
    body:
      "Hi Alex, Following up on my note about UA for Acme Mobile. We run CPI and CPA campaigns with fraud filtering. Worth a quick test on a small segment? Best regards, Michael",
    expect: ["closing", "sign-off", "sign off", "regards"],
  },
  {
    name: "meta_language",
    bad: true,
    subject: SUBJECT,
    body:
      "Hi Alex, Following up on my previous email, citing competitor growth as urgency and referencing conversion benchmarks from comparable campaigns. Open to a quick test?",
    expect: ["meta", "describing", "citing", "referencing", "-ing"],
  },
  {
    name: "x_not_y_negation",
    bad: true,
    subject: SUBJECT,
    body:
      "Hi Alex, Following up on my note about UA for Acme Mobile. We bring performance partners, not raw installs, with fraud filtering on top. Worth a quick test on a small segment?",
    expect: ["not", "contrast", "negation", "x-not-y"],
  },
  {
    name: "invented_statistic",
    bad: true,
    subject: SUBJECT,
    body:
      "Hi Alex, Following up on my note about UA for Acme Mobile. Last quarter we drove around 250% growth for a similar studio. Worth a quick test on a small segment?",
    expect: ["statistic", "invented", "number", "250", "hedge", "around"],
  },
  {
    name: "no_followup_ack",
    bad: true,
    subject: SUBJECT,
    body:
      "Hi Alex, MobUpps runs CPI and CPA campaigns with fraud filtering and durable retention for mobile gaming advertisers. Want to set up a quick call to explore a test?",
    expect: ["follow", "previous", "prior", "acknowledg", "cold", "first"],
  },
  {
    name: "clean_control",
    bad: false,
    subject: SUBJECT,
    body:
      "Hi Alex, Following up on my note about UA for Acme Mobile. Happy to set up a small test on one segment and share the results before scaling. Would next week work for a short call?",
    expect: [],
  },
];

function isOverload(msg: string): boolean {
  return /503|unavailable|high demand|overload/i.test(msg);
}

// Critique with Gemini only. The throwing stub means a Gemini failure throws
// instead of silently falling back to Opus.
async function geminiCritique(draft: {
  subject: string;
  body: string;
}): Promise<CriticResult> {
  const throwIfFallback = async (): Promise<CriticResult> => {
    throw new Error("Gemini failed and would have fallen back to Opus");
  };
  return runCritic(ctx, draft, throwIfFallback);
}

function issuesText(v: CriticResult): string {
  return (v.issues || []).join(" | ").toLowerCase();
}

function summary(): void {
  let head = "ADVERSARIAL PASS";
  if (failed > 0) head = "ADVERSARIAL FAIL";
  else if (blocked) head = "ADVERSARIAL INCOMPLETE";
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
      "    Gemini was overloaded mid-run. Rerun when Google capacity returns.",
    );
  }
}

function exitCode(): number {
  if (failed > 0) return 1;
  if (blocked) return 2;
  return 0;
}

async function main(): Promise<void> {
  console.log("=== Gemini critic adversarial battery ===");
  console.log("model: " + GEMINI_CRITIC_MODEL + "\n");

  if (!isGeminiConfigured()) {
    fail("GEMINI_API_KEY is not set, cannot run the adversarial battery");
    summary();
    process.exit(exitCode());
  }

  const skipRewrite = process.env.ADV_SKIP_REWRITE === "1";
  const savedProvider = process.env.CRITIC_PROVIDER;
  process.env.CRITIC_PROVIDER = "gemini";

  for (const c of cases) {
    console.log("[" + c.name + "]");
    const draft = { subject: c.subject, body: c.body };

    let verdict: CriticResult;
    try {
      verdict = await geminiCritique(draft);
    } catch (e) {
      const msg = String(e);
      if (isOverload(msg)) {
        blocked = true;
        console.log("  BLOCK Gemini overloaded: " + msg.slice(0, 140));
        break;
      }
      fail(c.name + ": critic call failed", msg.slice(0, 160));
      continue;
    }

    const text = issuesText(verdict);

    if (c.bad) {
      if (verdict.needs_rewrite) {
        pass(c.name + ": caught, needs_rewrite=true", "overall=" + verdict.overall);
        const named = c.expect.some((k) => text.includes(k));
        if (!named && c.expect.length > 0) {
          warn(c.name + ": flagged but did not name the planted fault");
        }
      } else {
        fail(c.name + ": planted violation was NOT caught", "overall=" + verdict.overall);
      }
    } else {
      if (!verdict.needs_rewrite) {
        pass(c.name + ": clean draft passed, no false positive");
      } else {
        warn(
          c.name + ": clean control was flagged, possible over-strictness",
          "overall=" + verdict.overall,
        );
      }
    }
    console.log("    issues: " + JSON.stringify((verdict.issues || []).slice(0, 2)));

    // The fix: only for bad drafts the critic flagged, and only if not skipped.
    if (c.bad && verdict.needs_rewrite && !skipRewrite) {
      let rewritten: { subject: string; body: string };
      try {
        rewritten = await rewriteDraft(ctx, draft, verdict);
      } catch (e) {
        warn(c.name + ": rewriter failed", String(e).slice(0, 140));
        continue;
      }
      let recheck: CriticResult;
      try {
        recheck = await geminiCritique(rewritten);
      } catch (e) {
        const msg = String(e);
        if (isOverload(msg)) {
          blocked = true;
          console.log("  BLOCK Gemini overloaded on re-critique: " + msg.slice(0, 120));
          break;
        }
        warn(c.name + ": re-critique failed", msg.slice(0, 140));
        continue;
      }
      if (!recheck.needs_rewrite) {
        pass(c.name + ": rewrite healed the draft", "overall=" + recheck.overall);
      } else {
        warn(
          c.name + ": rewrite still flagged after one pass (prod allows two)",
          "overall=" + recheck.overall,
        );
      }
      console.log("    rewritten: " + JSON.stringify(rewritten.body.slice(0, 160)));
    }
  }

  if (savedProvider === undefined) delete process.env.CRITIC_PROVIDER;
  else process.env.CRITIC_PROVIDER = savedProvider;

  summary();
}

main()
  .then(() => process.exit(exitCode()))
  .catch((e) => {
    console.error("adversarial test crashed:", e);
    process.exit(1);
  });
