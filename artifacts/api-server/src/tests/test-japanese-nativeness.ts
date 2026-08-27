/**
 * test-japanese-nativeness.ts
 *
 * Locks the Japanese-specific fixes made after a native review of a real
 * pipeline-produced email (Hidenori Terao, MobUpps BD, Aug 2026 — Hidenori.pdf).
 *
 * Two things are under test:
 *
 *   1. The render-time exemplar normalizer, which repairs register and
 *      punctuation defects the STORED exemplars teach. It lives at render time
 *      because followupExemplarsData.ts is generated from a JSONL that is not
 *      in this repo, so a direct edit would be lost on regeneration.
 *   2. The rule text itself, because the defect being fixed was an INSTRUCTION
 *      ("Nothing else stays in Latin script") rather than a code path. A prompt
 *      regression cannot be caught by exercising code, only by asserting the
 *      text still says the right thing.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-japanese-nativeness.ts
 */
import * as test from "node:test";
import * as assert from "node:assert/strict";

import { normalizeJapaneseExemplarBody, buildWriterExemplarBlock } from "../lib/exemplarLibrary";
import { FOLLOWUP_EXEMPLARS } from "../lib/followupExemplarsData";
import { buildNativenessBlock } from "../lib/languageNativeness";
import { applyJapaneseRegister, withJapaneseClosing, JAPANESE_CLOSINGS } from "../lib/japaneseRegister";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// The exemplar normalizer
// ---------------------------------------------------------------------------

test.describe("Japanese exemplar normalizer", () => {
  test.it("drops the ASCII comma after 様 — Japanese does not punctuate a salutation", () => {
    // 39/39 stored JA exemplars open "NAME様," — the English "Hi Alex," shape
    // imported wholesale. 39 counter-examples beat any prompt rule.
    assert.equal(normalizeJapaneseExemplarBody("カワマタ様,\n本文です。"), "カワマタ様\n本文です。");
    assert.equal(normalizeJapaneseExemplarBody("カワマタ様、\n本文です。"), "カワマタ様\n本文です。");
    assert.equal(normalizeJapaneseExemplarBody("カワマタ様 ,\n本文です。"), "カワマタ様\n本文です。");
  });

  test.it("leaves a 様 that is not ending a line alone", () => {
    // Only the salutation is a target; 様 inside a sentence is ordinary text.
    const mid = "本文で山田様にご確認いただいた件です。";
    assert.equal(normalizeJapaneseExemplarBody(mid), mid);
  });

  test.it("moves our own company to the humble 弊社", () => {
    // Outbound sales in Japanese is written in 謙譲語. 当社 is neutral and reads
    // as internal/corporate; 7 of 39 exemplars used it while 8 used 弊社, so the
    // set taught the writer that either was acceptable.
    assert.equal(normalizeJapaneseExemplarBody("当社の実績です。"), "弊社の実績です。");
    assert.equal(normalizeJapaneseExemplarBody("当社は当社の在庫を"), "弊社は弊社の在庫を");
  });

  test.it("moves the recipient's company to the email-register 御社", () => {
    // 貴社 is correct for written documents and contracts, 御社 for email.
    // No stored exemplar trips this today; it guards against regeneration
    // reintroducing the document form.
    assert.equal(normalizeJapaneseExemplarBody("貴社の課金ユーザー"), "御社の課金ユーザー");
  });

  test.it("repairs every stored JA exemplar and leaves no residual defect", () => {
    const ja = FOLLOWUP_EXEMPLARS.filter((e) => e.language === "ja");
    assert.ok(ja.length >= 39, `expected the JA exemplar set, got ${ja.length}`);
    for (const e of ja) {
      const out = normalizeJapaneseExemplarBody(e.body);
      assert.ok(!/様[ \t]*[,、，][ \t]*(\r?\n|$)/m.test(out), `${e.id}: salutation comma survived`);
      assert.ok(!out.includes("当社"), `${e.id}: 当社 survived`);
      assert.ok(!out.includes("貴社"), `${e.id}: 貴社 survived`);
    }
  });

  test.it("changes nothing but register and punctuation", () => {
    // The exemplars' claims, figures and structure are gold-standard content;
    // this normalizer must never touch them. Length may only change by the
    // removed salutation comma (1 char) — 当社/弊社 and 貴社/御社 are the same width.
    const ja = FOLLOWUP_EXEMPLARS.filter((e) => e.language === "ja");
    for (const e of ja) {
      const out = normalizeJapaneseExemplarBody(e.body);
      const delta = e.body.length - out.length;
      assert.ok(delta >= 0 && delta <= 2, `${e.id}: unexpected length change of ${delta}`);
      // Digits carry the illustrative figures; none may be lost or altered.
      assert.deepEqual(out.match(/\d+/g) ?? [], e.body.match(/\d+/g) ?? [], `${e.id}: figures changed`);
    }
  });

  test.it("is applied only to Japanese — no other language is touched", () => {
    // The normalizer's substitutions are Japanese-specific; running them over
    // e.g. Chinese (which shares 社) would be wrong. renderOne gates on
    // language === "ja"; this asserts the gate by rendering a non-JA block and
    // confirming no Japanese-only artifact appears.
    const es = buildWriterExemplarBlock({
      original_language: "es",
      vertical: "ecommerce",
      product: "cps",
      stage: 2,
    });
    assert.ok(es.length > 0, "expected a Spanish exemplar block");
    assert.ok(!es.includes("弊社"), "Spanish block must not carry Japanese register tokens");
  });

  test.it("the rendered JA block is clean end to end", () => {
    const block = buildWriterExemplarBlock({
      original_language: "ja",
      vertical: "gaming_midcore_hardcore",
      product: "ua",
      stage: 2,
    });
    assert.ok(block.includes("language=ja"), "expected native JA exemplars to be selected");
    assert.ok(!/様[ \t]*[,、，][ \t]*(\r?\n)/.test(block), "salutation comma reached the prompt");
    assert.ok(!block.includes("当社"), "当社 reached the prompt");
  });
});

// ---------------------------------------------------------------------------
// The LIVE rule text
// ---------------------------------------------------------------------------

test.describe("Japanese writer nativeness block (live path)", () => {
  const ja = buildNativenessBlock("ja");

  test.it("permits acronyms AND proper nouns in Latin script", () => {
    // The defect a native reviewer flagged was acronyms and company names
    // spelled out phonetically in katakana (エーピーエスフライヤー for AppsFlyer).
    // The live v3 block already carries the right policy — verified empirically
    // by smoke-japanese-nativeness.ts, which found 0 transliterations in 9
    // live cells — so this test pins the policy rather than fixing it.
    assert.match(ja, /proper nouns/i);
    for (const token of ["AppsFlyer", "Adjust", "D7", "D30", "MMP", "LTV"]) {
      assert.ok(ja.includes(token), `live rule should permit ${token}`);
    }
  });

  test.it("requires the FOLLOW-UP apology, not the first-contact one", () => {
    // Every email this system sends is a follow-up. 突然 means "sudden" and is
    // wrong on the facts in a second or third touch — and it collides with the
    // FOLLOWUP-ACK reference sitting in the same opening.
    assert.ok(ja.includes("度々のご連絡失礼いたします"), "follow-up apology missing");
    assert.match(ja, /Do NOT use '突然のご連絡失礼いたします/);
  });

  test.it("states the register and salutation rules", () => {
    assert.match(ja, /弊社/);
    assert.match(ja, /never 当社/);
    assert.match(ja, /御社/);
    assert.match(ja, /貴社 is for written documents/);
    assert.match(ja, /NO trailing comma/);
  });

  test.it("frames the meeting ask as an exchange", () => {
    assert.ok(ja.includes("情報交換"), "collaborative close should offer an exchange framing");
  });
});

// ---------------------------------------------------------------------------
// The output path
// ---------------------------------------------------------------------------

test.describe("Japanese register applied to OUTPUT", () => {
  test.it("normalizes a Japanese body", () => {
    const out = applyJapaneseRegister("カワマタ様,\n当社は貴社を支援します。", "ja");
    assert.equal(out, "カワマタ様\n弊社は御社を支援します。");
  });

  test.it("is a no-op for every other language", () => {
    // The substitutions are Japanese-specific. Chinese shares the character 社
    // and must never be touched by them.
    const zh = "您好，敝公司与贵社合作。";
    assert.equal(applyJapaneseRegister(zh, "zh"), zh);
    const en = "Hi Alex,\nOur company works with your company.";
    assert.equal(applyJapaneseRegister(en, "en"), en);
    assert.equal(applyJapaneseRegister(zh, null), zh);
    assert.equal(applyJapaneseRegister(zh, undefined), zh);
  });

  test.it("matches regional Japanese tags", () => {
    assert.equal(applyJapaneseRegister("当社", "ja-JP"), "弊社");
    assert.equal(applyJapaneseRegister("当社", "JA"), "弊社");
  });

  test.it("NEVER eats the blank line under the greeting", () => {
    // The bug this locks (audit round 3): the salutation-comma regex used \s*,
    // which matches newlines — so on a SHAPED body the match swallowed the
    // first newline and the replacement collapsed the blank line the layout
    // shaper had just guaranteed, recreating the robotic-layout defect of the
    // 2026-08-26 incident. In production this normalizer runs AFTER the
    // shaper, so nothing downstream would have repaired it. Only horizontal
    // whitespace may be consumed.
    assert.equal(
      applyJapaneseRegister("カワマタ様,\n\n本文です。", "ja"),
      "カワマタ様\n\n本文です。",
    );
    assert.equal(
      applyJapaneseRegister("カワマタ様、\n\n本文です。", "ja"),
      "カワマタ様\n\n本文です。",
    );
  });

  test.it("handles the full-width comma and end-of-text", () => {
    assert.equal(applyJapaneseRegister("カワマタ様，\n本文です。", "ja"), "カワマタ様\n本文です。");
    assert.equal(applyJapaneseRegister("最後の行が様,", "ja"), "最後の行が様");
  });

  test.it("is idempotent, so running it twice cannot drift", () => {
    // humanizeFollowup applies it, and the smoke applies it again to compare
    // modes. Both must land on the same text.
    const once = applyJapaneseRegister("カワマタ様,\n当社と貴社", "ja");
    assert.equal(applyJapaneseRegister(once, "ja"), once);
  });

  test.it("every JA return path in all three generators applies it", () => {
    // A source sweep, because the risk is a NEW return path added later that
    // skips the normalizer — which no unit test of the function itself would
    // catch. Each generator funnels its returns through one finalize/humanize
    // helper; this asserts that helper carries the call.
    const files = [
      "services/followupGenerator.ts",
      "services/contextFollowupGenerator.ts",
      "services/antiGhostingFollowupGenerator.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(resolve(SRC, rel), "utf8");
      assert.match(
        src,
        /applyJapaneseRegister\(/,
        `${rel} must normalize Japanese register on its shipped body`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The closing courtesy
// ---------------------------------------------------------------------------

test.describe("Japanese closing courtesy (結びの挨拶)", () => {
  const body = "カワマタ様\n\n度々のご連絡失礼いたします。弊社の実績をご案内します。\n\n一度お打ち合わせのお時間を頂戴できますでしょうか。";

  test.it("appends exactly one vetted closing to a Japanese body", () => {
    const out = withJapaneseClosing(body, "ja", "ShopNova|Subject|1");
    const last = out.split("\n").pop() as string;
    assert.ok(JAPANESE_CLOSINGS.includes(last), `unexpected closing: ${last}`);
    // Separated from the CTA by a blank line, above where the client's
    // signature will land — exactly where the native reviewer's own FIXED
    // version places it.
    assert.ok(out.includes("でしょうか。\n\n"), "closing must sit in its own block");
  });

  test.it("is deterministic per seed and rotates across stages", () => {
    // Same seed → same closing (regenerated draft, preview and sent message
    // must agree). Different stages in one thread → not all identical, so a
    // prospect never reads the same courtesy three times running.
    const s1 = withJapaneseClosing(body, "ja", "Acme|Sub|1");
    assert.equal(withJapaneseClosing(body, "ja", "Acme|Sub|1"), s1);
    const endings = [1, 2, 3].map(
      (st) => withJapaneseClosing(body, "ja", `Acme|Sub|${st}`).split("\n").pop(),
    );
    assert.ok(new Set(endings).size >= 2, "stages should rotate the closing");
  });

  test.it("is idempotent — a body that already ends with a set closing gains nothing", () => {
    const once = withJapaneseClosing(body, "ja", "Acme|Sub|1");
    assert.equal(withJapaneseClosing(once, "ja", "Acme|Sub|1"), once);
    // Even under a DIFFERENT seed: the guard is "ends with any set closing",
    // not "ends with my closing", so reprocessing can never stack two.
    assert.equal(withJapaneseClosing(once, "ja", "Other|Seed|9"), once);
  });

  test.it("is a no-op for every other language — B8a stands outside Japanese", () => {
    const en = "Hi Alex,\n\nFollowing up on my note.\n\nWorth a quick call?";
    assert.equal(withJapaneseClosing(en, "en", "x"), en);
    assert.equal(withJapaneseClosing(en, null, "x"), en);
  });

  test.it("every closing in the set is a single keigo line ending in 。", () => {
    for (const c of JAPANESE_CLOSINGS) {
      assert.ok(!c.includes("\n"), "closings are single lines");
      assert.ok(c.endsWith("。"), "closings end with 。");
      assert.match(c, /よろしくお願い/, "closings are the standard courtesy family");
    }
    // The native reviewer's exact line is in the set — this feature exists
    // because his FIXED version ends with it.
    assert.ok(JAPANESE_CLOSINGS.includes("ご確認のほど何卒よろしくお願い申し上げます。"));
  });

  test.it("every generator ships the closing (source sweep)", () => {
    for (const rel of [
      "services/followupGenerator.ts",
      "services/contextFollowupGenerator.ts",
      "services/antiGhostingFollowupGenerator.ts",
    ]) {
      const src = readFileSync(resolve(SRC, rel), "utf8");
      assert.match(src, /withJapaneseClosing\(/, `${rel} must append the JA closing`);
    }
  });
});
