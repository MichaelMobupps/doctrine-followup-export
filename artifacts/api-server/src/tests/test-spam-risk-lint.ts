/**
 * test-spam-risk-lint.ts
 *
 * Locks the deterministic contract of the spam-risk linter (2026-07-23
 * deliverability incident): follow-up-count phrasing, spam-trigger lexicon
 * with grounding exemption, list formatting, shouting, money bait, link
 * hygiene, subject checks, and the send-gate scoring. No DB, no network,
 * no LLM.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-spam-risk-lint.ts
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  detectSpamRiskViolations,
  assessSpamRisk,
  spamGateEnabled,
  spamGateMode,
} from "../lib/spamRiskLint";

function hasIssue(report: { issues: string[] }, code: string): boolean {
  return report.issues.some((i) => i.includes(code));
}

const EN = { languageTag: "en" };

// ---------------------------------------------------------------------------
// clean controls
// ---------------------------------------------------------------------------
test("clean english follow-up passes", () => {
  const body =
    "Hi John,\n" +
    "Following up on my note about the Brazil campaign. We delivered 250 installs last month " +
    "and the D7 retention held steady across the cohort. Worth a quick call next week?";
  const r = detectSpamRiskViolations(body, EN);
  assert.equal(r.found, false);
});

test("clean spanish follow-up passes", () => {
  const body =
    "Hola María. ¿Cómo estás?\n" +
    "Dando seguimiento a mi correo anterior sobre la campaña de México. Creo que puede tener " +
    "sentido evaluar un piloto comparativo. ¿Tendrías disponibilidad la próxima semana?";
  const r = detectSpamRiskViolations(body, { languageTag: "es" });
  assert.equal(r.found, false);
});

test("clean hebrew follow-up passes", () => {
  const body =
    "שלום דנה, מקווה שאת בסדר.\n" +
    "בהמשך למייל הקודם שלי על הקמפיין, חשבתי שיהיה מעניין לבדוק פיילוט קטן. האם תהיי זמינה לשיחה בשבוע הבא?";
  const r = detectSpamRiskViolations(body, { languageTag: "he" });
  assert.equal(r.found, false);
});

// ---------------------------------------------------------------------------
// S1 FOLLOWUP-COUNT — the incident phrase and variants
// ---------------------------------------------------------------------------
test("'reached out 6 times' flags FOLLOWUP-COUNT (incident phrase)", () => {
  const body =
    "Hi Michael,\nI've reached out 6 times about our affiliate program and wanted to try once more. Worth a chat?";
  const r = detectSpamRiskViolations(body, EN);
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("'my third email' flags FOLLOWUP-COUNT", () => {
  const body = "Hi,\nThis is my third email about the Q3 campaign. Following up on my note. Any thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("'emailed you several times' flags FOLLOWUP-COUNT", () => {
  const body = "Hi,\nI have emailed you several times regarding the integration. Could we connect?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("'after 4 unanswered messages' flags FOLLOWUP-COUNT", () => {
  const body = "Hi,\nAfter 4 unanswered messages I wanted to try a different angle on the campaign. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("natural single follow-up ack does NOT flag", () => {
  const body =
    "Hi,\nFollowing up on my previous email about the affiliate program. We added two new supply partners. Worth a look?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("'250 times faster' style figure does NOT flag as count", () => {
  const body =
    "Hi,\nFollowing up on my note. The campaign delivered results in Brazil three times over target. Worth a chat?";
  const r = detectSpamRiskViolations(body, EN);
  // "three times over target" has no contact verb adjacency in the EN patterns
  assert.ok(!hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("spanish contact-count sentence flags FOLLOWUP-COUNT", () => {
  const body =
    "Hola,\nTe he escrito tres veces sobre la campaña sin respuesta. ¿Podemos hablar?";
  const r = detectSpamRiskViolations(body, { languageTag: "es" });
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("spanish count without contact verb does NOT flag", () => {
  const body =
    "Hola,\nDando seguimiento a mi correo anterior. La campaña creció tres veces este trimestre. ¿Hablamos?";
  const r = detectSpamRiskViolations(body, { languageTag: "es" });
  assert.ok(!hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("german contact-count sentence flags FOLLOWUP-COUNT", () => {
  const body =
    "Guten Tag,\nich habe Ihnen bereits dreimal geschrieben wegen der Kampagne. Haben Sie kurz Zeit?";
  const r = detectSpamRiskViolations(body, { languageTag: "de" });
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("russian contact-count sentence flags FOLLOWUP-COUNT", () => {
  const body =
    "Здравствуйте,\nЯ писал вам три раза по поводу кампании. Можем созвониться?";
  const r = detectSpamRiskViolations(body, { languageTag: "ru" });
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("hebrew contact-count sentence flags FOLLOWUP-COUNT", () => {
  const body =
    "שלום,\nפניתי אליך שלוש פעמים בנוגע לקמפיין ולא קיבלתי מענה. אפשר לקבוע שיחה?";
  const r = detectSpamRiskViolations(body, { languageTag: "he" });
  assert.ok(hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

test("untabled language (japanese) count phrasing is skipped, not guessed", () => {
  const body = "田中様、以前のメールについてです。3回ご連絡しました。ご確認いただけますか。";
  const r = detectSpamRiskViolations(body, { languageTag: "ja" });
  assert.ok(!hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
});

// ---------------------------------------------------------------------------
// S2 SPAM-TRIGGER — lexicon + grounding exemption
// ---------------------------------------------------------------------------
test("'Bitcoins' flags SPAM-TRIGGER when not grounded (incident word)", () => {
  const body =
    "Hi,\nFollowing up on my note about the gaming leads. Some of them pay in Bitcoins which makes settlement fast. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "SPAM-TRIGGER"));
});

test("'Mercado Bitcoin' is exempt when present in the original email", () => {
  const body =
    "Hi,\nFollowing up on my note about gaming platforms. Mercado Bitcoin scaled their UA program last quarter. Worth a look?";
  const r = detectSpamRiskViolations(body, {
    languageTag: "en",
    originalText:
      "Original pitch: we work with key gaming and digital platforms such as Afterverse, Tapps Games, Mercado Bitcoin and Wildlife Studios.",
  });
  assert.ok(!hasIssue(r, "SPAM-TRIGGER"));
});

test("'crypto' exempt for a crypto-vertical original, flagged otherwise", () => {
  const body =
    "Hi,\nFollowing up on my previous email. Your crypto exchange audience matches our supply well. Worth a test?";
  const grounded = detectSpamRiskViolations(body, {
    languageTag: "en",
    originalText: "We help crypto exchange apps acquire verified KYC users at scale.",
  });
  assert.ok(!hasIssue(grounded, "SPAM-TRIGGER"));
  const ungrounded = detectSpamRiskViolations(body, {
    languageTag: "en",
    originalText: "We help fintech banking apps acquire verified users at scale.",
  });
  assert.ok(hasIssue(ungrounded, "SPAM-TRIGGER"));
});

test("urgency bait flags SPAM-TRIGGER", () => {
  const body =
    "Hi,\nFollowing up on my note. This is a limited time offer so act now to lock the rate. Interested?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-TRIGGER"));
});

test("click bait flags SPAM-TRIGGER", () => {
  const body = "Hi,\nFollowing up on my note about the program. Click here to see the case study. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-TRIGGER"));
});

test("russian-script bitcoin flags SPAM-TRIGGER", () => {
  const body =
    "Здравствуйте,\nВозвращаясь к моему письму. Мы также работаем с биткоин-проектами. Интересно?";
  const r = detectSpamRiskViolations(body, { languageTag: "ru" });
  assert.ok(hasIssue(r, "SPAM-TRIGGER"));
});

// ---------------------------------------------------------------------------
// S3 LIST-FORMAT
// ---------------------------------------------------------------------------
test("bulleted brand list flags LIST-FORMAT (incident shape)", () => {
  const body =
    "Hi,\nFollowing up on my note. Could you introduce us to:\n" +
    "- Unidas\n- Lojas Riachuelo\n- Sofisa\n- Ng.Cash\nThanks";
  const r = detectSpamRiskViolations(body, EN);
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "SPAM-LIST-FORMAT"));
});

test("numbered list flags LIST-FORMAT", () => {
  const body =
    "Hi,\nFollowing up on my note about the program. Three quick points:\n1. Supply quality\n2. Settlement terms\n3. Reporting\nThoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-LIST-FORMAT"));
});

test("long comma enumeration blob flags LIST-FORMAT", () => {
  const body =
    "Hi,\nFollowing up on my note. We could target Unidas, Lojas Riachuelo, Sofisa, Ng.Cash, Vulcabras, Panvel, Rentcars, UAI Rango and Midway. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-LIST-FORMAT"));
});

test("two or three named examples in prose do NOT flag", () => {
  const body =
    "Hi,\nFollowing up on my note. Brands like Panvel and Rentcars grew their CPS programs with us last quarter, mostly on confirmed purchases. Worth a look?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-LIST-FORMAT"));
});

test("normal multi-paragraph prose does NOT flag as parallel lines", () => {
  const body =
    "Hi there,\n" +
    "Following up on my note about the campaign.\n" +
    "We added two supply partners in Brazil last month and both are exclusive to us.\n" +
    "Worth a quick call next week?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-LIST-FORMAT"));
});

// ---------------------------------------------------------------------------
// S4 SHOUTING
// ---------------------------------------------------------------------------
test("non-acronym ALL-CAPS words flag SHOUTING", () => {
  const body = "Hi,\nFollowing up on my note. This is an AMAZING opportunity for your team. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-SHOUTING"));
});

test("curated acronyms do NOT flag SHOUTING", () => {
  const body =
    "Hi,\nFollowing up on my note. The ROAS held at target and CPI stayed flat, with D7 retention steady per the MMP data. Worth a look?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-SHOUTING"));
});

test("punctuation runs flag SHOUTING", () => {
  const body = "Hi,\nFollowing up on my note about the program!! Any update??";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-SHOUTING"));
});

// ---------------------------------------------------------------------------
// S5 MONEY-BAIT
// ---------------------------------------------------------------------------
test("currency next to bait word flags MONEY-BAIT", () => {
  const body = "Hi,\nFollowing up on my note. We can offer a free $500 bonus credit to start. Interested?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-MONEY-BAIT"));
});

test("plain factual currency figure does NOT flag MONEY-BAIT", () => {
  const body = "Hi,\nFollowing up on my note. The pilot budget was $5,000 across two weeks with daily caps. Worth reviewing?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-MONEY-BAIT"));
});

// ---------------------------------------------------------------------------
// S6 LINK-HYGIENE
// ---------------------------------------------------------------------------
test("two URLs flag LINK-HYGIENE", () => {
  const body =
    "Hi,\nFollowing up on my note. See https://example.com/case-study and https://example.com/deck for details. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-LINK-HYGIENE"));
});

test("URL shortener flags LINK-HYGIENE", () => {
  const body = "Hi,\nFollowing up on my note. Details here: https://bit.ly/3xYzAb. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(hasIssue(r, "SPAM-LINK-HYGIENE"));
});

test("single full-domain URL does NOT flag", () => {
  const body = "Hi,\nFollowing up on my note. The case study is at https://mobupps.com/cases/brazil. Thoughts?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-LINK-HYGIENE"));
});

// ---------------------------------------------------------------------------
// S7 SUBJECT
// ---------------------------------------------------------------------------
test("trigger word in subject flags SPAM-SUBJECT", () => {
  const body = "Hi,\nFollowing up on my note about the program. Worth a chat?";
  const r = detectSpamRiskViolations(body, {
    languageTag: "en",
    subject: "Re: Limited time offer for your team",
  });
  assert.ok(hasIssue(r, "SPAM-SUBJECT"));
});

test("exclamation in subject flags SPAM-SUBJECT", () => {
  const body = "Hi,\nFollowing up on my note. Worth a chat?";
  const r = detectSpamRiskViolations(body, { languageTag: "en", subject: "Re: Quick question!" });
  assert.ok(hasIssue(r, "SPAM-SUBJECT"));
});

test("plain Re: subject does NOT flag", () => {
  const body = "Hi,\nFollowing up on my note. Worth a chat?";
  const r = detectSpamRiskViolations(body, {
    languageTag: "en",
    subject: "Re: MobUpps x Acme - performance partnership",
  });
  assert.ok(!hasIssue(r, "SPAM-SUBJECT"));
});

test("subject trigger grounded in original subject is exempt", () => {
  const body = "Hi,\nFollowing up on my note. Worth a chat?";
  const r = detectSpamRiskViolations(body, {
    languageTag: "en",
    subject: "Re: Mercado Bitcoin partnership",
    originalText: "Mercado Bitcoin partnership\nOriginal body here.",
  });
  assert.ok(!hasIssue(r, "SPAM-SUBJECT"));
});

// ---------------------------------------------------------------------------
// dense-script safety: CJK/Thai clean bodies must not false-positive
// ---------------------------------------------------------------------------
test("clean japanese follow-up passes all rules", () => {
  const body =
    "田中様\n突然のご連絡失礼いたします。先日お送りしたメールの件でご連絡いたしました。ご検討いただけますと幸いです。来週お時間いただけますでしょうか。";
  const r = detectSpamRiskViolations(body, { languageTag: "ja" });
  assert.equal(r.found, false);
});

test("clean thai follow-up passes all rules", () => {
  const body =
    "เรียน คุณสมชาย หวังว่าคุณสบายดี\nติดตามอีเมลก่อนหน้าเกี่ยวกับแคมเปญ เราได้เพิ่มพันธมิตรใหม่ในไตรมาสนี้ คุณสะดวกคุยสัปดาห์หน้าหรือไม่:";
  const r = detectSpamRiskViolations(body, { languageTag: "th" });
  assert.equal(r.found, false);
});

// ---------------------------------------------------------------------------
// layer + rule kill switches
// ---------------------------------------------------------------------------
test("SPAM_LINT_ENABLED=0 disables the whole layer", () => {
  process.env.SPAM_LINT_ENABLED = "0";
  const body = "Hi,\nI've reached out 6 times about Bitcoins!! Click here:\n- one\n- two\n- three";
  const r = detectSpamRiskViolations(body, EN);
  assert.equal(r.found, false);
  delete process.env.SPAM_LINT_ENABLED;
});

test("SPAM_CHECK_FOLLOWUP_COUNT=0 disables only that rule", () => {
  process.env.SPAM_CHECK_FOLLOWUP_COUNT = "0";
  const body = "Hi,\nI've reached out 6 times about the program. Worth a chat?";
  const r = detectSpamRiskViolations(body, EN);
  assert.ok(!hasIssue(r, "SPAM-FOLLOWUP-COUNT"));
  delete process.env.SPAM_CHECK_FOLLOWUP_COUNT;
});

// ---------------------------------------------------------------------------
// assessSpamRisk — send-gate scoring
// ---------------------------------------------------------------------------
test("incident-style email is highRisk", () => {
  const subject = "Re: Introductions";
  const body =
    "Hi,\nI've reached out 6 times about this. Could you introduce us to:\n" +
    "- Unidas\n- Lojas Riachuelo\n- Mercado Bitcoin\n- Wildlife Studios\nSome pay in Bitcoins.";
  const risk = assessSpamRisk(subject, body, "en");
  assert.equal(risk.highRisk, true);
  assert.ok(risk.score >= 6);
  assert.ok(risk.rules.includes("FOLLOWUP-COUNT"));
  assert.ok(risk.rules.includes("LIST-FORMAT"));
});

test("clean email scores zero", () => {
  const risk = assessSpamRisk(
    "Re: MobUpps x Acme",
    "Hi John,\nFollowing up on my note about the Brazil campaign. We delivered 250 installs last month. Worth a quick call?",
    "en",
  );
  assert.equal(risk.score, 0);
  assert.equal(risk.highRisk, false);
});

test("single lesser signal is not highRisk", () => {
  // one extra URL pair only → weight 2 < 3 threshold
  const risk = assessSpamRisk(
    "Re: MobUpps x Acme",
    "Hi,\nFollowing up on my note. See https://a.com/x and https://b.com/y. Thoughts?",
    "en",
  );
  assert.equal(risk.highRisk, false);
});

test("gate helpers: defaults are enabled + block", () => {
  delete process.env.SPAM_GATE_ENABLED;
  delete process.env.SPAM_GATE_MODE;
  assert.equal(spamGateEnabled(), true);
  assert.equal(spamGateMode(), "block");
  process.env.SPAM_GATE_MODE = "warn";
  assert.equal(spamGateMode(), "warn");
  delete process.env.SPAM_GATE_MODE;
  process.env.SPAM_GATE_ENABLED = "0";
  assert.equal(spamGateEnabled(), false);
  delete process.env.SPAM_GATE_ENABLED;
});
