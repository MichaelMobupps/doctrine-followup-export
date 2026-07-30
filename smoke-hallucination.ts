/**
 * smoke-hallucination.ts
 *
 * Checks the follow-up WRITER for hallucinations.
 *
 * Default mode runs the live writing pipeline on a small set of built-in
 * cases, including traps designed to tempt a hallucination (no company on
 * file, no statistics in the source, a non-Latin language). It then audits
 * every generated email.
 *
 * Real mode instead audits the last N follow-ups your system already wrote,
 * read from the database it connects to.
 *
 * Run (built-in cases):
 *   cd /home/runner/workspace/artifacts/api-server
 *   pnpm exec tsx smoke-hallucination.ts
 *
 * Run (your real drafts, last 15):
 *   pnpm exec tsx smoke-hallucination.ts real 15
 *
 * Nothing is sent. The test only reads and audits.
 */

import { anthropic, MODEL_DRAFT_GENERATOR } from "./src/lib/anthropic";
import { detectAllDeterministicViolations } from "./src/lib/doctrineLint";
import { generateFollowupEmail } from "./src/services/followupGenerator";
import type { FollowupContext } from "./src/services/followupPrompts";

type AuditRow = {
  who: string;
  company: string;
  language: string;
  source: string; // the facts the writer was allowed to use
  subject: string;
  body: string;
};

type JudgeResult = {
  recipient_mismatch: string[];
  unsupported_prospect_claims: string[];
  added_industry_claims: string[];
};

let hardFindings = 0;
let checked = 0;

function header(s: string) {
  console.log("\n" + "=".repeat(68) + "\n" + s + "\n" + "=".repeat(68));
}

// ── The grounding judge ────────────────────────────────────────────
async function judge(source: string, body: string): Promise<JudgeResult> {
  const sys =
    "You audit a sales follow-up email for hallucinations. You get the SOURCE " +
    "(the only facts known about the prospect and the original outreach) and " +
    "the FOLLOW-UP (the email written to them). Sort the FOLLOW-UP's concrete, " +
    "checkable claims. Output ONLY JSON, no prose, shape:\n" +
    '{"recipient_mismatch":[],"unsupported_prospect_claims":[],"added_industry_claims":[]}\n' +
    "recipient_mismatch: any person name, company, or job role in the FOLLOW-UP " +
    "that conflicts with the SOURCE prospect identity.\n" +
    "unsupported_prospect_claims: specific factual claims about THIS prospect or " +
    "THEIR company that are not in the SOURCE.\n" +
    "added_industry_claims: general market facts, statistics, competitor moves, " +
    "or case studies the email asserts that are not in the SOURCE. These may be " +
    "legitimate additions; list them for human review.\n" +
    "A neutral greeting, or the prospect's own name or company from the SOURCE, " +
    "is not a mismatch. Generic encouragement or a question is not a claim. If a " +
    "category is empty, use [].";

  const resp = await anthropic.messages.create({
    model: MODEL_DRAFT_GENERATOR,
    max_tokens: 1024,
    system: sys,
    messages: [
      { role: "user", content: `SOURCE:\n${source}\n\nFOLLOW-UP:\n${body}` },
    ],
  });
  const text = resp.content.find((b) => b.type === "text");
  const raw = text && text.type === "text" ? text.text : "{}";
  const match = raw.match(/\{[\s\S]*\}/);
  try {
    const parsed = JSON.parse(match ? match[0] : raw);
    return {
      recipient_mismatch: parsed.recipient_mismatch ?? [],
      unsupported_prospect_claims: parsed.unsupported_prospect_claims ?? [],
      added_industry_claims: parsed.added_industry_claims ?? [],
    };
  } catch {
    return { recipient_mismatch: [], unsupported_prospect_claims: [], added_industry_claims: [] };
  }
}

// ── Audit one generated email ──────────────────────────────────────
async function audit(row: AuditRow, allNames: string[]) {
  checked++;
  console.log(`\n--- ${row.who || "(no name)"} @ ${row.company || "(no company)"} [${row.language}] ---`);
  console.log(`Subject: ${row.subject}`);
  console.log(`Body:\n${row.body}\n`);

  // 1. Code-only rules.
  const det = detectAllDeterministicViolations(row.body, row.language);
  if (det.found) {
    hardFindings++;
    console.log(`[FAIL] code rules: ${det.issues.slice(0, 4).join(" | ")}`);
  } else {
    console.log("[PASS] code rules (no filler, no language leak, correct script)");
  }

  // 2. Right person, no foreign name. In non-Latin languages the name is
  // correctly transliterated (e.g. Ivan -> Иван), so the Latin spelling will
  // not appear; the code-rules check already enforces the greeting script
  // there, so we only do the Latin-name presence check for Latin languages.
  const latinLangs = new Set([
    "en", "es", "pt", "fr", "it", "de", "nl", "id", "ms", "sw", "fil", "tl",
    "vi", "cs", "pl", "hu", "ro", "tr", "sv", "no", "nb", "da", "fi",
  ]);
  const first = (row.who || "").trim().split(/\s+/)[0] || "";
  if (first && latinLangs.has((row.language || "en").toLowerCase())) {
    const present = row.body.toLowerCase().includes(first.toLowerCase());
    if (present) console.log("[PASS] addresses the correct person");
    else console.log("[REVIEW] the prospect's first name does not appear (could be a correct neutral greeting, or a miss)");
  } else if (first) {
    console.log("[INFO] non-Latin language: the name is expected to be transliterated; the code rules already check the greeting script");
  }
  const foreign = allNames
    .filter((n) => n && n.toLowerCase() !== first.toLowerCase() && n.length >= 4)
    .filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(row.body));
  if (foreign.length > 0) {
    hardFindings++;
    console.log(`[FAIL] another person's name appears in this email: ${foreign.join(", ")}`);
  }

  // 3. Grounding judge.
  const j = await judge(row.source, row.body);
  if (j.recipient_mismatch.length > 0) {
    hardFindings++;
    console.log(`[FAIL] wrong-recipient facts: ${j.recipient_mismatch.join(" | ")}`);
  }
  if (j.unsupported_prospect_claims.length > 0) {
    hardFindings++;
    console.log(`[FAIL] unsupported claims about the prospect: ${j.unsupported_prospect_claims.join(" | ")}`);
  }
  if (j.added_industry_claims.length > 0) {
    console.log(`[REVIEW] industry claims the writer added (verify these are true): ${j.added_industry_claims.join(" | ")}`);
  }
  if (
    !det.found &&
    foreign.length === 0 &&
    j.recipient_mismatch.length === 0 &&
    j.unsupported_prospect_claims.length === 0
  ) {
    console.log("=> CLEAN (no hard findings)");
  }
}

// ── Built-in cases, including traps ────────────────────────────────
function builtInCases(): FollowupContext[] {
  const base = {
    sender_name: "Michael Goder",
    days_since_original: 5,
    stage: 1,
  };
  return [
    {
      ...base,
      prospect_name: "Sarah Chen",
      company: "PlaySphere",
      vertical: "gaming_ua",
      sub_vertical: "casual",
      product: "ua",
      original_subject: "User acquisition for PlaySphere casual titles",
      original_body_summary: "Offered MobUpps incremental UA for casual games with measurement via AppsFlyer.",
      original_body: "We help casual game studios scale installs with incremental users measured in AppsFlyer.",
      original_language: "en",
    },
    {
      // TRAP: no company on file. The writer must not invent an employer.
      ...base,
      prospect_name: "David Okoro",
      company: "",
      vertical: "non_gaming_ua",
      sub_vertical: null,
      product: "ua",
      original_subject: "A quick idea on your app growth",
      original_body_summary: "Introduced MobUpps performance UA, no company named.",
      original_body: "Reaching out about performance user acquisition for your app.",
      original_language: "en",
    },
    {
      // TRAP: source has no numbers. Watch for an invented statistic.
      ...base,
      stage: 2,
      prospect_name: "Mark Reilly",
      company: "Northwind Apps",
      vertical: "non_gaming_ua",
      sub_vertical: "finance",
      product: "ua",
      original_subject: "Following up on your finance app",
      original_body_summary: "Mentioned MobUpps can help acquire users for finance apps.",
      original_body: "We work with finance apps on user acquisition.",
      original_language: "en",
    },
    {
      // Non-Latin: greeting name must be in Cyrillic, no Latin-script leak.
      ...base,
      prospect_name: "Ivan Petrov",
      company: "Mobio",
      vertical: "gaming_ua",
      sub_vertical: "midcore",
      product: "ua",
      original_subject: "Привлечение пользователей для Mobio",
      original_body_summary: "Предложили MobUpps масштабирование установок для мидкор-игр.",
      original_body: "Мы помогаем студиям мидкор-игр масштабировать установки.",
      original_language: "ru",
    },
    {
      // TRAP: tempts a fabricated metric about the prospect's own title.
      ...base,
      stage: 3,
      prospect_name: "Lena Fischer",
      company: "Bauhaus Digital",
      vertical: "gaming_ua",
      sub_vertical: "casual",
      product: "cps",
      original_subject: "CPS partnership for Bauhaus Digital",
      original_body_summary: "Proposed a cost-per-sale partnership, no performance figures shared.",
      original_body: "We run cost-per-sale partnerships for app advertisers.",
      original_language: "en",
    },
  ];
}

async function runBuiltIn() {
  header("MODE: built-in trap cases (runs the live writer)");
  const cases = builtInCases();
  const names = cases.map((c) => (c.prospect_name || "").split(/\s+/)[0]);
  for (const ctx of cases) {
    let out;
    try {
      out = await generateFollowupEmail(ctx);
    } catch (e) {
      hardFindings++;
      console.log(`\n[FAIL] generation threw for ${ctx.prospect_name}: ${String(e)}`);
      continue;
    }
    if (!out) continue;
    const source =
      `Prospect: ${ctx.prospect_name || "(none)"}\n` +
      `Company: ${ctx.company || "(none provided)"}\n` +
      `Vertical/product: ${ctx.vertical} / ${ctx.product}\n` +
      `Original subject: ${ctx.original_subject}\n` +
      `Original email: ${ctx.original_body}\n` +
      `Summary: ${ctx.original_body_summary}`;
    await audit(
      { who: ctx.prospect_name, company: ctx.company, language: ctx.original_language, source, subject: out.subject, body: out.body },
      names,
    );
  }
}

async function runReal(n: number) {
  header(`MODE: your real drafts (last ${n})`);
  const { db } = await import("@workspace/db");
  const { sql } = await import("drizzle-orm");
  const r: any = await db.execute(sql.raw(
    `SELECT p.prospect_name, p.company, p.vertical, p.product,
            p.subject AS orig_subject, p.original_body_summary, p.original_body,
            p.original_language, f.generated_subject, f.generated_body
     FROM followups f JOIN prospects p ON p.id = f.prospect_id
     WHERE f.generated_body IS NOT NULL AND length(f.generated_body) > 0
     ORDER BY f.id DESC LIMIT ${Math.max(1, Math.min(50, n))}`,
  ));
  const rows: any[] = r.rows ?? r ?? [];
  if (rows.length === 0) {
    console.log("No stored drafts found in this database. If you meant production, set DATABASE_URL to the production connection string and rerun.");
    return;
  }
  const names = rows.map((x) => (x.prospect_name || "").split(/\s+/)[0]);
  for (const x of rows) {
    const source =
      `Prospect: ${x.prospect_name || "(none)"}\n` +
      `Company: ${x.company || "(none provided)"}\n` +
      `Vertical/product: ${x.vertical} / ${x.product}\n` +
      `Original subject: ${x.orig_subject}\n` +
      `Original email: ${x.original_body || x.original_body_summary}\n` +
      `Summary: ${x.original_body_summary}`;
    await audit(
      { who: x.prospect_name, company: x.company, language: x.original_language || "en", source, subject: x.generated_subject || "", body: x.generated_body },
      names,
    );
  }
}

async function main() {
  const mode = process.argv[2] === "real" ? "real" : "builtin";
  const n = parseInt(process.argv[3] || "15", 10);
  if (mode === "real") await runReal(isNaN(n) ? 15 : n);
  else await runBuiltIn();

  header(`RESULT: ${checked} emails checked, ${hardFindings} hard finding(s)`);
  console.log(
    hardFindings === 0
      ? "No wrong-recipient or invented-prospect-fact problems were found.\n" +
        "Review any [REVIEW] industry claims above by eye, since their truth cannot be verified automatically."
      : "One or more emails had a hard finding above. Send me the output and I will trace it.",
  );
  process.exit(hardFindings === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
