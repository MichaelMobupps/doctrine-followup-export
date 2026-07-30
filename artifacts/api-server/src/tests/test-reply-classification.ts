/**
 * test-reply-classification.ts
 *
 * Locks the deterministic contract of the Company-Reply Cascade's pure
 * layer: company-grouping key, out-of-office detection, unsubscribe
 * detection, and the recency window. No DB, no network, no LLM.
 *
 * Run: pnpm --filter @workspace/api-server exec tsx --test src/tests/test-reply-classification.ts
 */

import * as test from "node:test";
import * as assert from "node:assert/strict";

import {
  extractEmailDomain,
  isOutOfOffice,
  isUnsubscribe,
  isWithinDays,
  windowBounds,
  COMPANY_CASCADE_WINDOW_DAYS,
} from "../lib/replyClassification";

test.describe("extractEmailDomain", () => {
  test.it("returns the exact lowercased host", () => {
    assert.equal(extractEmailDomain("John.Doe@PizzaHut.com"), "pizzahut.com");
  });
  test.it("parses a From-header form", () => {
    assert.equal(extractEmailDomain("Jane Roe <jane@acme.io>"), "acme.io");
  });
  test.it("does NOT collapse subdomains (precision over recall)", () => {
    assert.notEqual(extractEmailDomain("a@uk.pizzahut.com"), extractEmailDomain("b@pizzahut.com"));
    assert.equal(extractEmailDomain("a@uk.pizzahut.com"), "uk.pizzahut.com");
  });
  test.it("returns '' for free webmail (never groups strangers)", () => {
    assert.equal(extractEmailDomain("someone@gmail.com"), "");
    assert.equal(extractEmailDomain("someone@yandex.ru"), "");
    assert.equal(extractEmailDomain("someone@walla.co.il"), "");
  });
  test.it("returns '' for junk input", () => {
    assert.equal(extractEmailDomain(""), "");
    assert.equal(extractEmailDomain("not-an-email"), "");
    assert.equal(extractEmailDomain("a@localhost"), "");
  });
  test.it("strips trailing punctuation on the host", () => {
    assert.equal(extractEmailDomain("a@acme.com."), "acme.com");
  });
});

test.describe("isOutOfOffice — header signals", () => {
  test.it("Auto-Submitted: auto-replied", () => {
    assert.equal(isOutOfOffice("Re: hi", "thanks", { autoSubmitted: "auto-replied" }), true);
  });
  test.it("X-Autoreply: yes", () => {
    assert.equal(isOutOfOffice("Re: hi", "thanks", { xAutoreply: "yes" }), true);
  });
  test.it("a normal human reply with no signals is not OOO", () => {
    assert.equal(isOutOfOffice("Re: partnership", "Sounds good, let us set up a call.", {}), false);
  });
});

test.describe("isOutOfOffice — multilingual phrases", () => {
  const cases: Array<[string, string]> = [
    ["Automatic reply", "I am out of the office until Monday."],
    ["", "I am currently away and will be back on the 5th."],
    ["Abwesenheitsnotiz", "Ich bin im Urlaub."],
    ["Réponse automatique", "Je suis absent du bureau."],
    ["Respuesta automática", "Estoy fuera de la oficina."],
    ["", "Estou de férias até segunda."],
    ["", "Sono fuori sede questa settimana."],
    ["", "Я сейчас в отпуске."],
    ["", "אני בחופשה ואחזור בשבוע הבא."],
    ["自動返信", "ただいま不在にしております。"],
    ["", "현재 휴가 중입니다."],
  ];
  for (const [subject, body] of cases) {
    test.it(`detects OOO: ${(subject || body).slice(0, 28)}`, () => {
      assert.equal(isOutOfOffice(subject, body), true);
    });
  }
});

test.describe("isUnsubscribe", () => {
  test.it("detects plain English opt-outs", () => {
    assert.equal(isUnsubscribe("Please unsubscribe me."), true);
    assert.equal(isUnsubscribe("take me off your list"), true);
    assert.equal(isUnsubscribe("stop emailing me"), true);
    assert.equal(isUnsubscribe("do not contact me again"), true);
  });
  test.it("does not fire on an interested reply", () => {
    assert.equal(isUnsubscribe("Interested, can you send pricing?"), false);
  });
  test.it("does not fire on a plain rejection (that is negative, not opt-out)", () => {
    assert.equal(isUnsubscribe("Not interested, thanks."), false);
  });
});

test.describe("recency window", () => {
  const anchor = new Date("2026-06-01T12:00:00Z");
  test.it("default window is 14 days", () => {
    assert.equal(COMPANY_CASCADE_WINDOW_DAYS, 14);
  });
  test.it("within window on either side", () => {
    assert.equal(isWithinDays(new Date("2026-06-10T12:00:00Z"), anchor, 14), true);
    assert.equal(isWithinDays(new Date("2026-05-23T12:00:00Z"), anchor, 14), true);
  });
  test.it("outside window is excluded", () => {
    assert.equal(isWithinDays(new Date("2026-06-20T12:00:00Z"), anchor, 14), false);
    assert.equal(isWithinDays(new Date("2026-05-10T12:00:00Z"), anchor, 14), false);
  });
  test.it("windowBounds brackets the anchor symmetrically", () => {
    const { lower, upper } = windowBounds(anchor, 14);
    assert.ok(lower < anchor && anchor < upper);
    assert.equal(upper.getTime() - anchor.getTime(), 14 * 86400_000);
    assert.equal(anchor.getTime() - lower.getTime(), 14 * 86400_000);
  });
});
