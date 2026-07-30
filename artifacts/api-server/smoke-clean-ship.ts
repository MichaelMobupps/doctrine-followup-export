/**
 * smoke-clean-ship.ts
 *
 * Verifies the clean-ship batch (batch 4):
 *
 *  PART A — AntiGhosting will not invent percentages.
 *    Runs the real AntiGhosting writer on cases that tempt it to make up a
 *    number, plus one case where a real number is present, and checks that
 *    every percentage in the output also appears in the seed email or thread.
 *    The grounding check here is an INDEPENDENT re-implementation, so it does
 *    not import the same code it is testing.
 *
 *  PART B — Doctrine treats a free-mail provider as no company.
 *    Deterministic. Builds the Doctrine writer prompt with company "Gmail" and
 *    with company "Playrix" and confirms the provider name is suppressed while
 *    the real company is kept. No model call, instant, free.
 *
 * Nothing is sent. Run from the api-server folder:
 *   cd /home/runner/workspace/artifacts/api-server
 *   pnpm exec tsx smoke-clean-ship.ts
 */

import { generateAntiGhostingFollowup } from "./src/services/antiGhostingFollowupGenerator";
import type { AntiGhostingFollowupContext } from "./src/services/antiGhostingFollowupPrompts";
import { detectAllDeterministicViolations } from "./src/lib/doctrineLint";
import { getFollowupUserPrompt } from "./src/services/followupPrompts";
import type { FollowupContext } from "./src/services/followupPrompts";

// Independent copy of the production grounding check.
function ungroundedPercentages(body: string, source: string): string[] {
  const norm = (s: string) => (s || "").toLowerCase().replace(/\s+/g, "");
  const src = norm(source);
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\d{1,3}(?:[.,]\d+)?\s*(?:[-\u2013\u2014]\s*\d{1,3}(?:[.,]\d+)?\s*)?%/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const raw = m[0].trim();
    const key = norm(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const digits = key.replace("%", "");
    if (src.includes(key) || src.includes(digits + "%")) continue;
    out.push(raw);
  }
  return out;
}

function agCase(over: Partial<AntiGhostingFollowupContext>): AntiGhostingFollowupContext {
  const now = new Date();
  return {
    prospect_name: "James Carter",
    prospect_email: "james@studiox.com",
    company: "StudioX",
    sender_name: "Michael Goder",
    seed_subject: "Re: UA partnership for StudioX",
    seed_body: "Hi James, following our chat we would line up an incremental UA test for your casual titles. Happy to walk through how we structure the measurement. Best, Michael",
    thread_messages: [
      { direction: "outbound", sentAt: now, fromName: "Michael Goder", fromEmail: "michael@mobupps.com", subject: "UA partnership for StudioX", body: "Hi James, reaching out about an incremental UA test for your casual titles." },
      { direction: "inbound", sentAt: now, fromName: "James Carter", fromEmail: "james@studiox.com", subject: "Re: UA partnership for StudioX", body: "Thanks Michael, interesting. Let me loop in our UA lead and revert." },
    ],
    stage: 1,
    cycle: 1,
    days_since_seed: 10,
    days_since_seed_tier: "lt_30d",
    original_language: "en",
    previous_followups: [],
    ...over,
  };
}

const AG_CASES: { name: string; ctx: AntiGhostingFollowupContext }[] = [
  {
    name: "EN, no numbers in source (any % would be invented)",
    ctx: agCase({}),
  },
  {
    name: "RU, no numbers in source",
    ctx: agCase({
      prospect_name: "Иван Петров",
      prospect_email: "ivan@mobio.ru",
      company: "Mobio",
      original_language: "ru",
      seed_subject: "Re: Привлечение пользователей для Mobio",
      seed_body: "Иван, по итогам разговора мы готовы запустить инкрементальный UA-тест для ваших мидкор-игр. С радостью расскажу, как мы выстраиваем измерения. Михаил",
      thread_messages: [
        { direction: "outbound", sentAt: new Date(), fromName: "Михаил", fromEmail: "michael@mobupps.com", subject: "Привлечение пользователей", body: "Иван, пишу по поводу инкрементального UA-теста для ваших игр." },
        { direction: "inbound", sentAt: new Date(), fromName: "Иван Петров", fromEmail: "ivan@mobio.ru", subject: "Re: Привлечение пользователей", body: "Спасибо, интересно. Обсужу с командой и вернусь." },
      ],
    }),
  },
  {
    name: "EN, a real 19% is present (grounded number must be allowed)",
    ctx: agCase({
      seed_body: "Hi James, following our chat: in a comparable campaign we saw a 19% lift in install volume at stable cost. Happy to walk through the setup. Best, Michael",
    }),
  },
];

async function runPartA(): Promise<{ pass: number; fail: number }> {
  console.log("\n================ PART A: AntiGhosting numbers grounding ================");
  let pass = 0, fail = 0;
  for (const c of AG_CASES) {
    console.log(`\n--- ${c.name} ---`);
    try {
      const out = await generateAntiGhostingFollowup(c.ctx);
      const source = [c.ctx.seed_subject, c.ctx.seed_body, ...c.ctx.thread_messages.map((m) => m.body)].join("\n");
      const bad = ungroundedPercentages(out.body, source);
      const det = detectAllDeterministicViolations(out.body, c.ctx.original_language);
      console.log(out.body);
      const problems: string[] = [];
      if (bad.length > 0) problems.push(`ungrounded percentage(s): ${bad.join(", ")}`);
      if (det.found) problems.push(`deterministic flag: ${det.matches.slice(0, 3).join(", ")}`);
      if (problems.length === 0) { pass++; console.log("RESULT: PASS"); }
      else { fail++; console.log("RESULT: FAIL — " + problems.join(" | ")); }
    } catch (e) {
      fail++;
      console.log("RESULT: FAIL — error: " + String(e));
    }
  }
  return { pass, fail };
}

function docCtx(company: string, prospect_name: string): FollowupContext {
  return {
    prospect_name,
    company,
    vertical: "gaming_ua",
    sub_vertical: "casual",
    product: "ua",
    original_subject: "User acquisition partnership",
    original_body_summary: "Incremental UA for casual games.",
    original_body: "We help casual studios scale installs with incremental users and transparent measurement.",
    original_language: "en",
    sender_name: "Michael Goder",
    days_since_original: 6,
    stage: 2,
    shared_company_draft: false,
    previous_followups: [],
  } as FollowupContext;
}

function runPartB(): { pass: number; fail: number } {
  console.log("\n\n================ PART B: Doctrine free-mail company guard ================");
  let pass = 0, fail = 0;
  try {
    // B-1: a free-mail provider stored as company must be suppressed.
    const gmailPrompt = getFollowupUserPrompt(docCtx("Gmail", "lead@gmail.com"));
    if (!/gmail/i.test(gmailPrompt)) {
      pass++; console.log('B-1 PASS: company "Gmail" is suppressed in the prompt.');
    } else {
      fail++; console.log('B-1 FAIL: the prompt still presents "Gmail" as a company.');
    }

    // B-2: a real company must still be used.
    const realPrompt = getFollowupUserPrompt(docCtx("Playrix", "anna@playrix.com"));
    if (/playrix/i.test(realPrompt)) {
      pass++; console.log('B-2 PASS: real company "Playrix" is kept in the prompt.');
    } else {
      fail++; console.log('B-2 FAIL: a real company was dropped, the guard is too aggressive.');
    }
  } catch (e) {
    fail++; console.log("PART B FAIL — error: " + String(e));
  }
  return { pass, fail };
}

async function main() {
  const a = await runPartA();
  const b = runPartB();
  const pass = a.pass + b.pass, fail = a.fail + b.fail;
  console.log("\n==================================================================");
  console.log(` SUMMARY: ${pass} passed, ${fail} failed (Part A ${a.pass}/${a.pass + a.fail}, Part B ${b.pass}/${b.pass + b.fail})`);
  console.log("==================================================================");
  if (fail === 0) console.log("Clean ship verified: AntiGhosting holds the line on numbers, and the free-mail guard fires.");
  else console.log("One or more checks failed. Read the case output above before relying on the deploy.");
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
