/**
 * test-structural-lint.ts
 *
 * Locks the deterministic contract of the structural linter: sentence-count
 * cap, forbidden dashes, verbatim overlap with the original, and follow-up
 * acknowledgment markers. No DB, no network, no LLM.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-structural-lint.ts
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { detectStructuralViolations, mergeViolationReports } from "../lib/structuralLint";

function hasIssue(report: { issues: string[] }, code: string): boolean {
  return report.issues.some((i) => i.includes(code));
}

// ---------------------------------------------------------------------------
// clean control
// ---------------------------------------------------------------------------
test("clean english follow-up passes", () => {
  const body =
    "Hi John,\n" +
    "Following up on my note about the Brazil campaign. We delivered 250 installs last month. " +
    "The D7 retention held steady. Worth a quick call next week?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, false);
});

// ---------------------------------------------------------------------------
// A. sentence-count cap
// ---------------------------------------------------------------------------
test("over-length english draft flags SENTENCE-COUNT", () => {
  const body =
    "Following up on my earlier email. One. Two. Three. Four. Five. Six. Seven. Eight more sentences here.";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "SENTENCE-COUNT"));
});

test("sentence-count rule is skipped for thai", () => {
  // Same nine periods, but Thai has no punctuation sentence delimiter, so the
  // rule must not fire. Thai ack markers are present to isolate rule A.
  const body =
    "เรียน คุณสมชาย ติดตามอีเมลก่อนหน้า. A. B. C. D. E. F. G. H.";
  const r = detectStructuralViolations(body, { languageTag: "th" });
  assert.ok(!hasIssue(r, "SENTENCE-COUNT"));
});

// ---------------------------------------------------------------------------
// B. forbidden dashes
// ---------------------------------------------------------------------------
test("em dash flags FORBIDDEN-DASH", () => {
  const body = "Following up on my note. We deliver quality \u2014 real durable revenue. Call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "FORBIDDEN-DASH"));
});

test("en dash flags FORBIDDEN-DASH", () => {
  const body = "Following up on my note. Volumes ran 200\u2013300 a day. Call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.ok(hasIssue(r, "FORBIDDEN-DASH"));
});

test("plain hyphen does not flag", () => {
  const body = "Following up on my note. We run pre-bid screening daily. Call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.ok(!hasIssue(r, "FORBIDDEN-DASH"));
});

// ---------------------------------------------------------------------------
// C. verbatim overlap
// ---------------------------------------------------------------------------
const ORIGINAL =
  "We run semi exclusive inventory with pre bid screening and cohort level anomaly detection across tier one markets.";

test("verbatim copy of the original flags VERBATIM-OVERLAP", () => {
  const body =
    "Hi John,\n" +
    "Following up on my earlier email. We run semi exclusive inventory with pre bid screening " +
    "and cohort level anomaly detection, which keeps revenue durable. Worth a call?";
  const r = detectStructuralViolations(body, { languageTag: "en", originalText: ORIGINAL });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "VERBATIM-OVERLAP"));
});

test("paraphrase of the original does not flag overlap", () => {
  const body =
    "Hi John,\n" +
    "Following up on my earlier email. We focus on durable supply and screen traffic before " +
    "bidding. Worth a call?";
  const r = detectStructuralViolations(body, { languageTag: "en", originalText: ORIGINAL });
  assert.ok(!hasIssue(r, "VERBATIM-OVERLAP"));
});

// ---------------------------------------------------------------------------
// D. follow-up acknowledgment
// ---------------------------------------------------------------------------
test("missing acknowledgment flags FOLLOWUP-ACK", () => {
  const body = "Hi John,\nWe deliver 250 installs a day in Brazil. Worth a call next week?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, true);
  assert.ok(hasIssue(r, "FOLLOWUP-ACK"));
});

test("present acknowledgment passes ack rule", () => {
  const body = "Hi John,\nCircling back on my previous email about Brazil. Worth a call?";
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("untabled language is skipped for ack (no false positive)", () => {
  // Swahili has no marker table, so absence of a marker must not flag.
  const body = "Habari John,\nTunatoa watumiaji bora kila siku. Tupige simu wiki ijayo?";
  const r = detectStructuralViolations(body, { languageTag: "sw" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("German 'melde mich noch einmal zu meiner E-Mail' counts as ack", () => {
  // Observed Gemini Pro draft that was wrongly flagged before the fix.
  const body =
    "Guten Tag Alex,\nIch melde mich noch einmal zu meiner E-Mail über eine CPS-Leistungspartnerschaft für ShopNova. Hätten Sie nächste Woche Zeit?";
  const r = detectStructuralViolations(body, { languageTag: "de" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("German umlaut marker matches despite accents (anknuepfend)", () => {
  const body =
    "Guten Tag Alex,\nAnknüpfend an meine vorherige Nachricht zu ShopNova. Hätten Sie Zeit?";
  const r = detectStructuralViolations(body, { languageTag: "de" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("Hebrew 'חזרתי על המייל שלי' counts as ack", () => {
  // Observed Sonnet draft that was wrongly flagged: a valid revisit phrasing the
  // Hebrew marker table did not cover.
  const body =
    "שלום אלכס,\nמקווה שאתה במצב טוב. חזרתי על המייל שלי בנושא קמפיינים לריטרגטינג עבור Wanderly Travel. האם תהיה זמין לשיחה?";
  const r = detectStructuralViolations(body, { languageTag: "he" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("Hebrew present-tense 'אני חוזר על המייל שלי' counts as ack", () => {
  const body =
    "שלום אלכס,\nמקווה שאתה במצב טוב. אני חוזר על המייל שלי בנושא מחזור משתמשים רדומים עבור Wanderly Travel. האם תהיה זמין לשיחה?";
  const r = detectStructuralViolations(body, { languageTag: "he" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("Chinese '给您发过一封邮件' counts as ack", () => {
  // Observed Flash draft on the production route that was wrongly flagged.
  const body =
    "您好，亚历克斯，\n冒昧打扰，上周我给您发过一封邮件，内容是关于为 ShopNova 引入 CPS 合作方案。您下周方便沟通吗？";
  const r = detectStructuralViolations(body, { languageTag: "zh" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

// Rule D, structure-based fallback: any two of REF, VERB, PRIOR count as ack.
test("structural ack: zh contact verb plus prior qualifier counts", () => {
  const body =
    "您好，亚历克斯，\n感谢您抽空阅读这封邮件。我们在此前联系您时，曾提到通过 CPS 模式为 ShopNova 带来增长。您下周方便沟通吗？";
  const r = detectStructuralViolations(body, { languageTag: "zh" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("structural ack: es message noun plus prior qualifier counts", () => {
  const body =
    "Hola, Alex. Espero que te encuentres bien. Es mi último mensaje sobre las campañas de reactivación. ¿Hablamos la próxima semana?";
  const r = detectStructuralViolations(body, { languageTag: "es" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("structural ack: ru return verb plus message noun counts", () => {
  const body =
    "Здравствуйте, Алекс,\nВозвращаюсь к своему письму о партнёрстве по модели CPS для ShopNova. Будете доступны на следующей неделе?";
  const r = detectStructuralViolations(body, { languageTag: "ru" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("structural ack: es feminine prior form 'Última nota' counts", () => {
  const body =
    "Hola, Alex. Espero que te encuentres bien.\nÚltima nota por mi parte sobre nuestra propuesta de reactivación para Wanderly Travel. ¿Hablamos la próxima semana?";
  const r = detectStructuralViolations(body, { languageTag: "es" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("structural ack: th contact verb plus prior qualifier counts", () => {
  const body =
    "เรียน อเล็กซ์,\nดิฉันขอติดต่อกลับมาอีกครั้งเกี่ยวกับแคมเปญดึงผู้ใช้กลับมาใช้งาน Wanderly Travel ที่เราได้คุยกันไปก่อนหน้านี้. คุณสะดวกคุยสัปดาห์หน้าไหม?";
  const r = detectStructuralViolations(body, { languageTag: "th" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("structural ack: de separable return verb 'komme auf ... zurück' counts", () => {
  const body =
    "Guten Tag Alex,\nich komme auf meinen Vorschlag bezüglich einer CPS-Leistungspartnerschaft für ShopNova zurück. Hätten Sie nächste Woche Zeit?";
  const r = detectStructuralViolations(body, { languageTag: "de" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
});

test("structural ack: zh time qualifier plus send verb counts", () => {
  const body =
    "您好，亚历克斯：\n冒昧打扰，上周我曾给您发信探讨关于 ShopNova 的 CPS 推广合作。您下周是否方便沟通？";
  const r = detectStructuralViolations(body, { languageTag: "zh" });
  assert.ok(!hasIssue(r, "FOLLOWUP-ACK"));
  // A non-acknowledgment that happens to mention sending traffic still flags.
  const noAck = detectStructuralViolations(
    "您好，亚历克斯，\n我们每天给您发优质流量。您下周方便沟通吗？",
    { languageTag: "zh" },
  );
  assert.ok(hasIssue(noAck, "FOLLOWUP-ACK"));
});

test("structural ack: genuine no-ack still flags after the fallback", () => {
  const en = detectStructuralViolations(
    "Hi John,\nWe deliver 250 installs a day in Brazil. Worth a call next week?",
    { languageTag: "en" },
  );
  assert.ok(hasIssue(en, "FOLLOWUP-ACK"));
  const ru = detectStructuralViolations(
    "Здравствуйте, Алекс,\nМы ежедневно поставляем качественный трафик. Поговорим на следующей неделе?",
    { languageTag: "ru" },
  );
  assert.ok(hasIssue(ru, "FOLLOWUP-ACK"));
});

// Rule C: the prospect company name is excluded from overlap.
test("VERBATIM-OVERLAP: company name is not a copied span", () => {
  const body =
    "アレックス様\n先日お送りした、Wanderly Travelの休眠ユーザー向けリターゲティングに関するメールのフォローアップです。";
  const original =
    "Re: MobUpps retargeting for Wanderly Travel\nHi Alex, we can help Wanderly Travel re-engage dormant users.";
  const flagged = detectStructuralViolations(body, { languageTag: "ja", originalText: original });
  assert.ok(hasIssue(flagged, "VERBATIM-OVERLAP"));
  const cleared = detectStructuralViolations(body, {
    languageTag: "ja",
    originalText: original,
    companyName: "Wanderly Travel",
  });
  assert.ok(!hasIssue(cleared, "VERBATIM-OVERLAP"));
});

test("VERBATIM-OVERLAP: a real copied span still flags with company set", () => {
  const body =
    "アレックス様\nwe can help wanderly travel re-engage dormant users with retargeting today";
  const original =
    "Re: MobUpps retargeting for Wanderly Travel\nHi Alex, we can help Wanderly Travel re-engage dormant users with retargeting.";
  const r = detectStructuralViolations(body, {
    languageTag: "en",
    originalText: original,
    companyName: "Wanderly Travel",
  });
  assert.ok(hasIssue(r, "VERBATIM-OVERLAP"));
});

// ---------------------------------------------------------------------------
// master toggle
// ---------------------------------------------------------------------------
test("STRUCTURAL_LINT_ENABLED=0 disables the whole layer", () => {
  process.env.STRUCTURAL_LINT_ENABLED = "0";
  const body = "Hi John,\nWe deliver 250 installs a day. Worth a call?"; // would normally flag ack
  const r = detectStructuralViolations(body, { languageTag: "en" });
  assert.equal(r.found, false);
  delete process.env.STRUCTURAL_LINT_ENABLED;
});

// ---------------------------------------------------------------------------
// merge helper
// ---------------------------------------------------------------------------
test("mergeViolationReports unions found reports", () => {
  const a = { found: true, issues: ["X"], suggestions: ["sx"], matches: ["mx"] };
  const b = { found: false, issues: [], suggestions: [], matches: [] };
  const merged = mergeViolationReports(a, b);
  assert.equal(merged.found, true);
  assert.deepEqual(merged.issues, ["X"]);
});

test("mergeViolationReports of empties is not found", () => {
  const empty = { found: false, issues: [], suggestions: [], matches: [] };
  const merged = mergeViolationReports(empty, empty);
  assert.equal(merged.found, false);
});
