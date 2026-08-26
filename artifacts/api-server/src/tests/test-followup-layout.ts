/**
 * test-followup-layout.ts — the 2026-08-26 layout / font / greeting work.
 *
 * Covers the three modules added for the "follow-ups read as machine-written"
 * feedback: lib/layoutShaper.ts (shape), lib/emailTypography.ts (font
 * inheritance and Gmail-shaped HTML), lib/greetingName.ts (recovering the
 * recipient's name from the original outreach).
 */
import test from "node:test";
import assert from "node:assert";

import {
  LAYOUT_PROFILES,
  selectLayoutProfile,
  shapeFollowupBody,
  splitGreetingLine,
  splitSentences,
  distributeSentences,
  buildLayoutDirective,
} from "../lib/layoutShaper";
import {
  extractFontFromHtml,
  fontStyleAttr,
  buildBodyHtml,
} from "../lib/emailTypography";
import { extractGreetingName, hasUsableProspectName } from "../lib/greetingName";

// The exact body from Robotic.jpeg, stage 1 of the HALA thread.
const ROBOTIC =
  "Hi there, following up on my previous note regarding subscription acquisition " +
  "for the HALA app across the Gulf. We are currently scaling to 125 validated paid " +
  "subscriptions per day by utilizing cohort-level whitelist filtering. Every " +
  "acquisition is confirmed through server-to-server MMP postbacks. This approach " +
  "allows for cleaner attribution and higher retention parity. Would you be open to " +
  "a brief walk-through of the current benchmarks?";

const HALA = { company: "HALA", prospect_name: "Ibrahim", original_subject: "HALA & MobUpps" };

// ---------------------------------------------------------------------------
test("profile selection", async (t) => {
  await t.test("consecutive stages of one thread never share a profile", () => {
    const ids = [1, 2, 3, 4, 5, 6].map((stage) => selectLayoutProfile({ ...HALA, stage }).id);
    assert.equal(new Set(ids).size, LAYOUT_PROFILES.length, `repeated shape in ${ids.join(",")}`);
  });

  await t.test("selection is deterministic across calls", () => {
    const a = selectLayoutProfile({ ...HALA, stage: 2 });
    const b = selectLayoutProfile({ ...HALA, stage: 2 });
    assert.equal(a.id, b.id);
  });

  await t.test("different threads walk the profiles in different orders", () => {
    const one = [1, 2, 3, 4].map((s) => selectLayoutProfile({ ...HALA, stage: s }).id).join(",");
    const two = [1, 2, 3, 4]
      .map((s) =>
        selectLayoutProfile({
          company: "Yalla",
          prospect_name: "Sara",
          original_subject: "Yalla & MobUpps",
          stage: s,
        }).id,
      )
      .join(",");
    assert.notEqual(one, two);
  });

  await t.test("stage beyond the profile count wraps instead of throwing", () => {
    const p = selectLayoutProfile({ ...HALA, stage: 9 });
    assert.ok(LAYOUT_PROFILES.some((x) => x.id === p.id));
  });

  await t.test("a missing stage is treated as stage 1", () => {
    assert.equal(selectLayoutProfile({ ...HALA }).id, selectLayoutProfile({ ...HALA, stage: 1 }).id);
  });
});

// ---------------------------------------------------------------------------
test("greeting splitting", async (t) => {
  await t.test("splits the Robotic.jpeg run-on greeting", () => {
    const r = splitGreetingLine("Hi there, following up on my previous note.", "en");
    assert.deepEqual(r, { greeting: "Hi there,", rest: "Following up on my previous note." });
  });

  await t.test("takes the comma after the name when the opener comes first", () => {
    assert.equal(
      splitGreetingLine("Здравствуйте, Иван, возвращаясь к письму.", "ru")?.greeting,
      "Здравствуйте, Иван,",
    );
  });

  await t.test("German keeps the lowercase letter after the greeting comma", () => {
    assert.equal(
      splitGreetingLine("Guten Tag Herr Müller, ich komme zurück auf meine E-Mail.", "de")?.rest,
      "ich komme zurück auf meine E-Mail.",
    );
  });

  await t.test("Japanese honorific greeting splits on the ideographic comma", () => {
    assert.equal(splitGreetingLine("田中様、先日お送りしたメールの件です。", "ja")?.greeting, "田中様、");
  });

  await t.test("a sentence that merely contains an early comma is left alone", () => {
    assert.equal(splitGreetingLine("Following up on my note, we saw a lift.", "en"), null);
  });

  await t.test("a greeting-shaped prefix inside a word does not match", () => {
    assert.equal(splitGreetingLine("Hiring is up, so timing matters.", "en"), null);
  });

  await t.test("a bare greeting with nothing after it is not a split", () => {
    assert.equal(splitGreetingLine("Hi Sarah,", "en"), null);
  });
});

// ---------------------------------------------------------------------------
test("sentence segmentation", async (t) => {
  await t.test("counts the Robotic.jpeg body correctly", () => {
    // Five, not six: the run-on greeting means "Hi there, following up ...
    // Gulf." is a single sentence, which is the defect the shaper repairs.
    assert.equal(splitSentences(ROBOTIC).length, 5);
  });

  await t.test("an abbreviation is not treated as a sentence end", () => {
    // Deliberately conservative: "Inc." is genuinely sentence-final here, but
    // the splitter cannot tell it from "Acme Inc. of Delaware" and errs toward
    // under-splitting. Under-splitting puts one extra sentence in a block;
    // over-splitting would cut a sentence in half in the shipped email.
    assert.equal(splitSentences("We work with Acme Inc. They scaled last quarter.").length, 1);
  });

  await t.test("does not split on a decimal", () => {
    assert.equal(splitSentences("The rate held at 4.1% last month.").length, 1);
  });

  await t.test("does not split before a lowercase continuation", () => {
    assert.equal(splitSentences("We saw a lift. it held for a week.").length, 1);
  });

  await t.test("caseless scripts split on the period (audit round 1)", () => {
    assert.equal(
      splitSentences("בהמשך למייל שלי. אנחנו מגיעים ל-250 התקנות ביום. יש לך זמן לשיחה?").length,
      3,
    );
    assert.equal(
      splitSentences("نصل إلى 250 تثبيت يوميًا. كل عملية مؤكدة عبر MMP. هل لديك وقت؟").length,
      3,
    );
  });

  await t.test("native terminals count: Arabic ؟ and Devanagari danda", () => {
    assert.equal(splitSentences("هل لديك وقت؟ نحن جاهزون.").length, 2);
    assert.equal(splitSentences("हम रोज़ 250 इंस्टॉल देते हैं। क्या आपके पास समय है?").length, 2);
  });

  await t.test("a sentence ending in an acronym still splits (audit round 1)", () => {
    assert.equal(splitSentences("Every acquisition is confirmed via MMP. Next we scale.").length, 2);
    assert.equal(splitSentences("We optimize to the FTD. Open to a quick look?").length, 2);
  });

  await t.test("a personal initial still does not split", () => {
    assert.equal(splitSentences("I spoke with J. Smith about it. He agreed.").length, 2);
  });

  await t.test("a legitimate short sentence is not folded away (audit round 1)", () => {
    assert.deepEqual(splitSentences("Following up on my note. We hit 250. Worth a call?"), [
      "Following up on my note.",
      "We hit 250.",
      "Worth a call?",
    ]);
  });
});

// ---------------------------------------------------------------------------
test("caseless-script shaping (audit round 1)", async (t) => {
  await t.test("a Hebrew wall of text gains blocks", () => {
    const he =
      "שלום דוד, בהמשך למייל שלי על קמפיין ה-UA. אנחנו מגיעים ל-250 התקנות ביום. כל רכישה מאומתת דרך MMP. יש לך זמן לשיחה קצרה?";
    const out = shapeFollowupBody(he, { profile: LAYOUT_PROFILES[4], languageTag: "he" });
    assert.ok(out.startsWith("שלום דוד,\n\n"));
    assert.ok(out.split("\n\n").length >= 3, out);
  });

  await t.test("an Arabic wall of text gains blocks", () => {
    const ar =
      "مرحبًا جون، متابعة بخصوص رسالتي السابقة عن حملات UA. نصل إلى 250 تثبيت يوميًا. كل عملية مؤكدة عبر MMP. هل لديك وقت لمكالمة قصيرة؟";
    const out = shapeFollowupBody(ar, { profile: LAYOUT_PROFILES[4], languageTag: "ar" });
    assert.ok(out.startsWith("مرحبًا جون،\n\n"));
    assert.ok(out.split("\n\n").length >= 3, out);
  });
});

// ---------------------------------------------------------------------------
test("sentence distribution", async (t) => {
  await t.test("matches the pattern when the counts agree", () => {
    assert.deepEqual(distributeSentences(5, [1, 3, 1], true), [1, 3, 1]);
  });

  await t.test("every block keeps at least one sentence", () => {
    for (const p of LAYOUT_PROFILES) {
      for (let n = 2; n <= 8; n++) {
        const d = distributeSentences(n, p.pattern, p.ctaStandalone);
        assert.ok(d.every((c) => c >= 1), `${p.id} n=${n} -> ${d.join(",")}`);
        assert.equal(d.reduce((a, b) => a + b, 0), n, `${p.id} n=${n} lost sentences`);
      }
    }
  });

  await t.test("a standalone closing question stays exactly one sentence", () => {
    for (const p of LAYOUT_PROFILES.filter((x) => x.ctaStandalone)) {
      for (let n = 3; n <= 8; n++) {
        const d = distributeSentences(n, p.pattern, p.ctaStandalone);
        assert.equal(d[d.length - 1], 1, `${p.id} n=${n}`);
      }
    }
  });

  await t.test("fewer sentences than blocks drops middle blocks, not the closer", () => {
    const d = distributeSentences(2, [1, 1, 2, 1], true);
    assert.equal(d.reduce((a, b) => a + b, 0), 2);
    assert.equal(d[d.length - 1], 1);
  });
});

// ---------------------------------------------------------------------------
test("body shaping", async (t) => {
  await t.test("the Robotic.jpeg body gains a greeting line and blocks", () => {
    for (const p of LAYOUT_PROFILES) {
      const out = shapeFollowupBody(ROBOTIC, { profile: p, languageTag: "en" });
      assert.ok(out.startsWith("Hi there,\n\n"), `${p.id}: greeting not isolated`);
      assert.ok(out.includes("\n\n", 12), `${p.id}: no block break`);
    }
  });

  await t.test("no sentence is lost, whatever the profile", () => {
    for (const p of LAYOUT_PROFILES) {
      const out = shapeFollowupBody(ROBOTIC, { profile: p, languageTag: "en" });
      assert.ok(out.includes("Would you be open to a brief walk-through"), `${p.id}`);
      assert.ok(out.includes("125 validated paid"), `${p.id}`);
    }
  });

  await t.test("the greeting-plus-single-newline exemplar shape gains a blank line", () => {
    const out = shapeFollowupBody(
      "Hi RECIPIENT_NAME,\nFollowing up on my note. We optimize to the FTD. Open to a quick look?",
      { profile: LAYOUT_PROFILES[0], languageTag: "en" },
    );
    assert.ok(out.startsWith("Hi RECIPIENT_NAME,\n\nFollowing up"));
  });

  await t.test("shaping is idempotent", () => {
    for (const p of LAYOUT_PROFILES) {
      const once = shapeFollowupBody(ROBOTIC, { profile: p, languageTag: "en" });
      assert.equal(shapeFollowupBody(once, { profile: p, languageTag: "en" }), once, p.id);
    }
  });

  await t.test("the model's own blocks are respected, not re-cut", () => {
    const authored = "Hi Sarah,\n\nOne line.\n\nTwo. Three.\n\nWorth a look?";
    assert.equal(
      shapeFollowupBody(authored, { profile: LAYOUT_PROFILES[3], languageTag: "en" }),
      authored,
    );
  });

  await t.test("no sentence boundaries are invented for Thai", () => {
    const th = "สวัสดี Somchai, ติดตามอีเมลก่อนหน้าเกี่ยวกับแคมเปญ";
    const out = shapeFollowupBody(th, { profile: LAYOUT_PROFILES[2], languageTag: "th" });
    assert.equal(out, "สวัสดี Somchai,\n\nติดตามอีเมลก่อนหน้าเกี่ยวกับแคมเปญ");
  });

  await t.test("blank-line runs collapse to one", () => {
    const out = shapeFollowupBody("Hi Sarah,\n\n\n\nOne line.\n\n\nTwo.", {
      profile: LAYOUT_PROFILES[1],
      languageTag: "en",
    });
    assert.ok(!out.includes("\n\n\n"));
  });

  await t.test("a body with no greeting is still blocked", () => {
    const out = shapeFollowupBody(
      "Following up on my note. We delivered 250 installs. D7 held steady. Worth a call?",
      { profile: LAYOUT_PROFILES[4], languageTag: "en" },
    );
    assert.ok(out.includes("\n\n"));
    assert.ok(out.startsWith("Following up"));
  });

  await t.test("FOLLOWUP_LAYOUT_SHAPER=0 returns the body untouched", () => {
    const prev = process.env.FOLLOWUP_LAYOUT_SHAPER;
    process.env.FOLLOWUP_LAYOUT_SHAPER = "0";
    try {
      assert.equal(shapeFollowupBody(ROBOTIC, { profile: LAYOUT_PROFILES[0] }), ROBOTIC);
    } finally {
      if (prev === undefined) delete process.env.FOLLOWUP_LAYOUT_SHAPER;
      else process.env.FOLLOWUP_LAYOUT_SHAPER = prev;
    }
  });

  await t.test("empty input stays empty", () => {
    assert.equal(shapeFollowupBody("", { profile: LAYOUT_PROFILES[0] }), "");
  });
});

// ---------------------------------------------------------------------------
test("layout directive", async (t) => {
  await t.test("every profile produces a directive naming its shape", () => {
    for (const p of LAYOUT_PROFILES) {
      const d = buildLayoutDirective(p);
      assert.ok(d.includes(p.directive), p.id);
      assert.ok(d.includes("LAYOUT"), p.id);
    }
  });

  await t.test("the directive never asks for lists, which deliverability bans", () => {
    for (const p of LAYOUT_PROFILES) {
      assert.ok(buildLayoutDirective(p).includes("Do NOT add bullet points"), p.id);
    }
  });
});

// ---------------------------------------------------------------------------
test("font inheritance", async (t) => {
  await t.test("reads an inline font off the original message", () => {
    const f = extractFontFromHtml(
      '<div dir="ltr" style="font-family: Arial, sans-serif; font-size: 11pt;">Hi</div>',
    );
    assert.equal(f.fontFamily, "Arial, sans-serif");
    assert.equal(f.fontSize, "11pt");
  });

  await t.test("reads the Calibri Light stack Prospector currently sends", () => {
    const f = extractFontFromHtml(
      '<div dir="ltr" style=\'font-family: "Calibri Light", Calibri, sans-serif; font-size: 11pt;\'>Hi</div>',
    );
    assert.equal(f.fontFamily, "'Calibri Light', Calibri, sans-serif");
  });

  await t.test("a message with no font declaration inherits nothing", () => {
    assert.deepEqual(extractFontFromHtml('<div dir="ltr">Hi there</div>'), {});
    assert.equal(fontStyleAttr({}), "");
  });

  await t.test("styling inside the quoted reply is ignored", () => {
    const html =
      '<div dir="ltr">Hi</div><div class="gmail_quote"><div style="font-family: Comic Sans MS;">old</div></div>';
    assert.deepEqual(extractFontFromHtml(html), {});
  });

  await t.test("a payload after the declaration is not carried through", () => {
    const f = extractFontFromHtml(
      '<div style="font-family: Arial;} body{background:url(http://x)">Hi</div>',
    );
    assert.equal(f.fontFamily, "Arial");
    assert.ok(!fontStyleAttr(f).includes("url("));
  });

  await t.test("a font-family carrying markup characters is rejected outright", () => {
    assert.equal(
      extractFontFromHtml('<div style="font-family: Arial<script>alert(1)</script>">Hi</div>')
        .fontFamily,
      undefined,
    );
  });

  await t.test("a quoted-printable style attribute is still readable", () => {
    const f = extractFontFromHtml('<div dir=3D"ltr" style=3D"font-family: Arial;">Hi</div>');
    assert.equal(f.fontFamily, "Arial");
  });

  await t.test("a font declared in a <style> block is picked up", () => {
    const f = extractFontFromHtml(
      "<style>body, p { font-family: Georgia, serif; font-size: 12pt; }</style><p>Hi</p>",
    );
    assert.equal(f.fontFamily, "Georgia, serif");
    assert.equal(f.fontSize, "12pt");
  });

  await t.test("double quotes in an inherited stack are normalised to single", () => {
    const attr = fontStyleAttr(extractFontFromHtml('<p style="font-family: &quot;X&quot;">hi</p>'));
    assert.ok(!attr.includes('"'));
  });

  await t.test("implausible sizes are dropped, the family is kept", () => {
    const f = extractFontFromHtml('<div style="font-family: Arial; font-size: 96pt;">Hi</div>');
    assert.equal(f.fontFamily, "Arial");
    assert.equal(f.fontSize, undefined);
  });

  await t.test("null and empty input are safe", () => {
    assert.deepEqual(extractFontFromHtml(null), {});
    assert.deepEqual(extractFontFromHtml(""), {});
  });
});

// ---------------------------------------------------------------------------
test("body HTML", async (t) => {
  await t.test("a blank line becomes a real paragraph gap", () => {
    assert.equal(
      buildBodyHtml("Hi Sarah,\n\nFollowing up."),
      "<div>Hi Sarah,</div><div><br></div><div>Following up.</div>",
    );
  });

  await t.test("a single newline inside a block is a tight break", () => {
    assert.equal(buildBodyHtml("One.\nTwo."), "<div>One.<br>Two.</div>");
  });

  await t.test("HTML in the body is escaped", () => {
    assert.ok(buildBodyHtml("a <b> & c").includes("&lt;b&gt; &amp; c"));
  });

  await t.test("literal backslash-n from a JSON round-trip is honoured", () => {
    assert.ok(buildBodyHtml("Hi,\\n\\nThere.").includes("<div><br></div>"));
  });

  await t.test("empty input produces no markup", () => {
    assert.equal(buildBodyHtml(""), "");
  });
});

// ---------------------------------------------------------------------------
test("greeting-name recovery", async (t) => {
  await t.test("recovers the name the HALA thread already had", () => {
    assert.equal(
      extractGreetingName("Hi Ibrahim, Sunil from MobUpps here. We run performance UA.", "en"),
      "Ibrahim",
    );
  });

  await t.test("recovers a name from a greeting-only first line", () => {
    assert.equal(extractGreetingName("Hello Sarah Chen,\nWe run UA campaigns.", "en"), "Sarah Chen");
  });

  await t.test("keeps the German honorific with the surname", () => {
    assert.equal(
      extractGreetingName("Guten Tag Herr Müller, wir betreiben UA-Kampagnen.", "de"),
      "Herr Müller",
    );
  });

  await t.test("drops the CJK honorific the writer prompt regenerates", () => {
    assert.equal(extractGreetingName("田中様、はじめまして。", "ja"), "田中");
  });

  await t.test("a generic opener yields no name", () => {
    assert.equal(extractGreetingName("Hi there, Sunil from MobUpps here.", "en"), null);
    assert.equal(extractGreetingName("Hi team, quick note.", "en"), null);
    assert.equal(extractGreetingName("Dear Sir, we run campaigns.", "en"), null);
  });

  await t.test("an email local-part is never treated as a name", () => {
    assert.equal(extractGreetingName("Hi ojaswee.singh, quick note.", "en"), null);
  });

  await t.test("a body with no greeting yields no name", () => {
    assert.equal(extractGreetingName("Following up on my note, we saw a lift.", "en"), null);
    assert.equal(extractGreetingName("", "en"), null);
    assert.equal(extractGreetingName(null, "en"), null);
  });

  await t.test("hasUsableProspectName rejects blanks and addresses", () => {
    assert.equal(hasUsableProspectName("Ibrahim"), true);
    assert.equal(hasUsableProspectName(""), false);
    assert.equal(hasUsableProspectName("   "), false);
    assert.equal(hasUsableProspectName("a@b.com"), false);
    assert.equal(hasUsableProspectName(null), false);
  });
});
