# TODO — Japanese email nativeness, per Hidenori Terao's native rewrite

**Source:** `Hidenori.pdf` — Hide Terao (Business Development Manager, MobUpps, native JA speaker)
sent Michael an `[ORIGINAL]` vs `[FIXED]` rewrite of a Japanese cold-outreach email, 2026-08-27.
**Ask:** apply his changes to Japanese emails — **to all Japanese exemplars, not just the writing rules.**
**Method:** godlike audit → blast radius → autofix → smoke → E2E.
**Status legend:** ☐ todo · ◐ in progress · ☑ done · ✗ dropped

---

## 1. What Hidenori actually changed (extracted from the PDF diff)

| # | Change | ORIGINAL | FIXED | Generalizable? |
|---|---|---|---|---|
| H1 | Subject line format | `🔵jig.jp co.,ltd & MobUpps` | `【mobupps寺尾】ご挨拶とmobuppsのご案内` | YES — 【sender-co + surname】 prefix is standard JA business email |
| H2 | Recipient company line | (absent) | `株式会社jig.jp` above the name line | YES — 会社名 then 担当者名様 is the standard header |
| H3 | Unsolicited-contact apology | (absent) | `突然のご連絡恐れ入ります。` | YES — near-mandatory JA cold-open |
| H4 | Humble self-reference | `当社` (neutral) | `弊社` (humble/謙譲) | YES — outbound sales uses 弊社 |
| H5 | Recipient reference | `貴社` (written-document register) | `御社` (spoken/email register) | YES for email |
| H6 | **Acronyms must stay Latin** | `エーピーエスフライヤー`, `エイジャスト`, `エスツーエス`, `ディーセブン`, `ディーサーティ`, `エルティービー` | `MMP`, `s2s`, `D7`, `D30` | **YES — highest-value fix** |
| H7 | Invented specifics removed | `日別22件`, `D7継続率25%`, `転換率9%`, `不正比率2%未満` | (all removed) | already our doctrine (CB-4) |
| H8 | Personalization verb | generic | `感銘いたしました` on their named initiative | YES |
| H9 | Meeting framing | `お打ち合わせの機会をいただけますでしょうか` | `情報交換を兼ねて…お時間を頂戴できますと幸甚です` | YES — softer, non-salesy |
| H10 | Closing courtesy line | (absent) | `ご確認のほど何卒よろしくお願い申し上げます。` | **CONFLICT with our B8a no-closing rule — see §3** |

### The headline finding (H6)

Our v3 Reading-A++ rule already *allows* `D7`, `D30`, `MMP`, `LTV` and proper nouns like
`AppsFlyer` / `Adjust` as permitted Latin tokens. But the ORIGINAL email spells them out
**phonetically in katakana** — `エーピーエスフライヤー` is "AppsFlyer" sounded out. A native reads that
as barely-parseable. So the rule permits the right thing but nothing *requires* it, and the
pressure of "translate everything" pushes the model to transliterate. Needs an explicit
**anti-transliteration** rule, not just an allowlist.

---

## 2. Progress

### Phase A — audit / blast radius — ☑ DONE

**Japanese surfaces found (blast radius):**

| File | What it holds for `ja` |
|---|---|
| `lib/followupExemplarsData.ts` | **39 JA exemplars** (of 1272), all market=Japan, 13 per stage |
| `lib/languageNativeness.ts` | the JA writer nativeness block — **root cause of H6** |
| `lib/nativenessV4.ts` | JA translationese patterns, `NATIVE_STYLE_GUIDES.ja` (social opener, closers), discourse markers |
| `lib/doctrineRules.ts` | 4 JA rule blocks |
| `lib/structuralLint.ts` | JA prior-outreach markers (FOLLOWUP-ACK) |
| `services/followupPrompts.ts` | critic rules 4 / 13a / 13h reference JA explicitly |
| `services/signatureStripper.ts` | strips JA closings (`よろしくお願いいたします` …) — **H10 conflict** |
| `lib/competitorNativeForms.ts` | JA competitor names |
| `lib/exemplarLibrary.ts` | renders exemplars; already re-shapes bodies at render time |

**A2 — current behaviour, measured against H1–H10 (all 39 JA exemplars):**

| check | result |
|---|---|
| H1 subject is the format Hidenori replaced | **39 / 39** |
| H2 recipient company line present | 0 / 39 |
| **ASCII `,` after `様`** (not Japanese punctuation) | **39 / 39** |
| H4 uses `当社` (should be humble `弊社`) | **7 / 39** |
| H4 uses `弊社` | 8 / 39 |
| H5 uses `貴社` | 0 / 39 (good) |
| H5 uses `御社` | 19 / 39 |
| H6 katakana-transliterated acronyms | 0 / 39 (exemplars clean) |
| H10 closing courtesy line | 0 / 39 |
| follow-up apology (`度々の…`) | 0 / 39 |

**A3 — what generalizes, and what does not.** Hidenori's email is a **first contact**; ours are
**threaded follow-up replies**. Three of his changes are first-contact-specific and must be adapted,
not copied:

- **H3 `突然のご連絡恐れ入ります`** ("sorry for the *sudden* contact") is factually wrong in a
  follow-up — it is the 2nd/3rd touch, not sudden. The native follow-up form is
  **`度々のご連絡失礼いたします`** ("excuse the *repeated* contact"). See F2 — we currently instruct
  the wrong one.
- **H2 company header** (`株式会社X` above the name) is standard for a first contact; repeating it on
  every threaded reply is heavy and unnatural. **Not applied to exemplars**; noted only.
- **H1 subject** — our follow-ups inherit `Re: <original subject>` from the thread, so the subject
  format is set by the *prospecting* system upstream, not by this repo. Recorded as an upstream
  recommendation.

### Phase B — autofix — ☑ DONE
- ✗ B1. Anti-transliteration rule (H6) — **not needed.** The live rule already permits acronyms and
      proper nouns, and 0/9 live cells transliterated. See the F1 retraction.
- ☑ B2. 弊社/御社 register (H4/H5) — prompt rule **and** a deterministic normalizer, because the
      prompt rule alone measured 67% failure. `lib/japaneseRegister.ts`, wired into all three flows.
- ☑ B3. Apology (H3), adapted for follow-ups: `度々/再度のご連絡失礼いたします`, replacing the
      first-contact `突然のご連絡失礼いたします` in `nativenessV4` and critic rules 12/13a.
- ✗ B3b. Company header (H2) — deliberately not applied. First-contact convention; repeating
      `株式会社X` on every threaded reply is unnatural.
- ✗ B4. Subject format (H1) — **not ours to fix.** Follow-ups inherit `Re: <original>` from the
      thread; the subject is set by the upstream Prospector. Recorded as an upstream item.
- ☑ B5. Closing-line conflict (H10) — **RESOLVED by Michael**: "create something in the same spirit
      Hidenori would agree with." Implemented as deterministic append — see §7.
- ☑ B6. All 39 Japanese exemplars normalized at render time (39/39 fixed, 0 residual).
- ☑ B7. H9 CTA framing (`情報交換を兼ねて`) added to the JA collaborative close.

### Phase C — verify — ☑ DONE
- ☑ C1. `tests/test-japanese-nativeness.ts` — **17 tests**: normalizer behaviour, all 39 exemplars
      clean with figures/length preserved, non-JA untouched, live rule text, idempotence, and a
      source sweep asserting every generator's ship path applies the normalizer.
- ☑ C2. `scripts/smoke-japanese-nativeness.ts` — deterministic J1–J5 grading, 9 cells, **grades RAW
      vs SHIPPED** so the safety net cannot hide a decaying prompt rule.
- ☑ C3. E2E: full pipeline **9/9 clean**; heal-loop JA **2/2 ship clean**, $0.0016/email.
- ☑ C4. Blast radius: non-JA (en, de, es, zh, ko, ru, ar) **71.4% clean — normal band**, no regression.
      Full suite **1,377 passed / 0 failed** (was 1,360; +17 JA tests).

## 3. OPEN DECISION for Michael — the Japanese closing line (H10)

Not applied, because it is a doctrine change and a business call about how MobUpps reads in Japan.
But the audit found the current behaviour is **arbitrary**, which is worth fixing whichever way you
decide. Measured directly:

| closing | today |
|---|---|
| `よろしくお願いいたします。` | **STRIPPED** |
| `よろしくお願いします。` | **STRIPPED** |
| `宜しくお願い致します。` | **STRIPPED** |
| `敬具` | **STRIPPED** |
| `何卒よろしくお願いいたします。` | **KEPT** |
| `ご確認のほど何卒よろしくお願い申し上げます。` | **KEPT** ← Hidenori's exact form |

The same courtesy survives or dies depending on whether it carries a `何卒` prefix. That is not a
policy, it is an artifact of the phrase list being line-anchored — so today a Japanese follow-up ends
politely or abruptly essentially at random.

**Context for the decision.** B8a strips closings because the mail client appends the sender's
signature. In English, "Best regards, Michael" genuinely is redundant with that signature. In
Japanese, `よろしくお願いいたします` is **not** a signature — it is the closing courtesy of the message
body, and Hidenori's native rewrite includes it *above* the `mobupps / 寺尾` signature block. Omitting
it reads abrupt.

**Options:**
1. **Keep JA closings** (drop the JA phrases from the strip list). Matches the native rewrite; makes
   JA mail read correctly. Cost: JA emails get one more line, and the doctrine's "no closing" rule
   stops being universal.
2. **Strip them all consistently** (add the `何卒…` / `…申し上げます` variants). Preserves the doctrine
   as written. Cost: keeps shipping a closing shape a native called wrong.
3. Status quo — arbitrary. Not defensible either way.

**My recommendation: option 1, scoped to Japanese only.** It is the only option that agrees with the
native reviewer, and the doctrine's reason for the rule (redundancy with the signature) does not hold
for Japanese. Implementation is ~20 lines: `stripClosingFromBody` currently takes no language, so it
needs a language argument threaded from the three `finalize`/`humanize` callers — the same three
places `applyJapaneseRegister` was just wired into.

## 4. Outcome summary

| Hidenori's change | verdict | where |
|---|---|---|
| H1 subject `【mobupps寺尾】…` | upstream (Prospector), not this repo | §2 A3 |
| H2 company header line | not applied — first-contact convention | §2 A3 |
| H3 apology, adapted → `度々のご連絡` | **applied** (rules + critic) | B3 |
| H4 `当社`→`弊社` | **applied** (rule + deterministic + 7 exemplars) | B2, B6 |
| H5 `貴社`→`御社` | **applied** (rule + deterministic; 67% → 0%) | B2 |
| H6 no katakana transliteration | already correct — 0/9 live | F1 retraction |
| H7 no invented specifics | already our doctrine (CB-4) | — |
| H8 personalization | already our doctrine (relevance/differentiation) | — |
| H9 `情報交換を兼ねて` CTA | **applied** | B7 |
| H10 closing courtesy | **decision for Michael** | §3 |

## 5. Findings

### F1 — ✗ RETRACTED. My first root-cause call was wrong.

**What I claimed:** that `lib/languageNativeness.ts`'s `ja` block — which says "Keep ONLY these pure
acronyms in English: <10 items>. **Nothing else stays in Latin script**", with no proper-noun
exemption — was ordering the katakana transliteration Hidenori flagged.

**Why it looked airtight:** the clause is a literal instruction to spell everything else out, the
allowlist really does contain `D7` but not `D30` (which would explain one being kept and the other
transliterated in the same sentence), and it really does omit proper nouns entirely.

**Why it is wrong:** that table feeds only `_buildNativenessBlock_v2_LEGACY_REMOVED`, which the file
itself documents as *"Retained for the audit trail only — not called from anywhere."* The live path
is `buildNativenessBlock` → `buildNativenessBlockV4`, and the v3 Reading-A++ policy it emits **already
permits** `(a)` a wide acronym set including `D30` and `(b)` proper nouns, naming `AppsFlyer` and
`Adjust` explicitly.

**How it was caught:** by a test asserting against the live block, which failed — and by then running
the pipeline for real. `smoke-japanese-nativeness.ts` found **0 transliterations in 9 live cells**
(and 0 again on the full pipeline). Our Follow-upper does not have this defect.

**Where the PDF's defect probably comes from:** the `[ORIGINAL]` in Hidenori.pdf is a **first-contact**
email (`MobUppsのヒデと申します`, introducing the company), and its subject `🔵jig.jp co.,ltd & MobUpps`
is the *original outreach* subject our follow-ups reply to. That is the upstream **Email Prospector**,
not this repo. Recorded as an upstream item — the Prospector has its own copy of these rules
(`pricing.ts` notes it mirrors `prospector/core/pricing.py`), and it is worth checking whether the
dead table here is the *live* one there.

**Action taken:** the dead-code edit was reverted, and the table now carries a `DEAD CODE` banner
explaining the trap so the next reader does not lose the same hour.

### F1b — the defect our pipeline DOES have: 貴社 instead of 御社

Chasing H6 turned up a **different, real, reproducible** defect — one measured rather than reasoned
about. `貴社` is the written-document form of "your company"; email uses `御社`. Hidenori changed every
instance. Our writer produces the document form constantly:

| measurement | 貴社 rate |
|---|---|
| writer-only, 9 cells (3 verticals x 3 stages) | **4/9 = 44%** |
| re-run after adding the rule to the prompt layer | **6/9 = 67%** |

The second row is the important one: the prompt rule was already live for that run. **A prompt rule
did not fix it.** It is a register substitution, not a reasoning error — the model is not wrong about
meaning, it just reaches for the stiffer word — so it needed a deterministic fix, which is how this
repo already handles comparable nativeness defects (`lib/discourseMarkerAutofix.ts`).

### F2 — BUG: we instruct the wrong apology for a follow-up

`nativenessV4.NATIVE_STYLE_GUIDES.ja.social_opener` and critic rule 13a both require:

> `突然のご連絡失礼いたします。` ("Japanese B2B cold outreach REQUIRES the apologetic opener")

This is a **cold-outreach** opener. Every email this repo sends is a **follow-up**, where "sorry for
the sudden contact" is wrong on the facts and collides with the FOLLOWUP-ACK requirement to reference
prior outreach in the same opening. Native follow-up form: `度々のご連絡失礼いたします` /
`再度のご連絡失礼いたします`.

### F2b — the exemplars were teaching the defect too

7 of 39 exemplars used `当社`; 0 used `貴社` (so the writer's 貴社 habit is its own, not learned here).
Both are now normalized at render time.

### F3 — all 39 exemplars carry a non-Japanese salutation comma

Every JA exemplar opens `RECIPIENT_NAME様,` with an **ASCII comma**. Japanese does not punctuate a
salutation that way — it is a direct import of the English `Hi Alex,` shape, and 39 counter-examples
are exactly the kind of thing that overrides a prompt rule.

### F4 — register inconsistency across exemplars

7 exemplars use `当社` (neutral) and 8 use `弊社` (humble). Outbound sales should be uniformly
`弊社`, which is what Hidenori changed and what `nativenessV4` register_notes already says.

### F5 — the exemplar data file cannot be hand-edited durably

`followupExemplarsData.ts` states it is generated from `Followupper_exemplars_widened.jsonl` and
"must not be hand-edited". **That JSONL is not in this repo**, so any direct edit is silently lost on
the next regeneration. The file already has precedent for fixing data defects at RENDER time instead
(`exemplarLibrary.ts` re-shapes every body's layout at render because 1209 stored bodies taught the
wrong shape). The JA fixes follow that same precedent, so they survive regeneration.


---

## 6. Audit round 3 (same day, after the JA work was called done)

### F6 — BUG in my own normalizer, found and fixed: it ate the greeting's blank line

`normalizeJapaneseSalutation` used `\s*` around the comma, and `\s` matches newlines. On a SHAPED
body — `カワマタ様,\n\n本文…` — the match swallowed the first newline and the replacement collapsed
the blank line the layout shaper had just guaranteed:

    IN : "カワマタ様,\n\n本文の一文目です。"
    OUT: "カワマタ様\n本文の一文目です。"      ← blank line gone

In production the normalizer runs AFTER the shaper (deliberately, so it cleans whatever ships), so
nothing downstream would have repaired this — any JA draft whose writer emitted the salutation comma
would have shipped with the exact robotic-layout defect of the 2026-08-26 incident. No earlier
measurement was corrupted (in every live run the writer happened to emit no comma; the printed
openings confirm the blank line survived), but the trap was armed.

Fixed: only horizontal whitespace (`[ \t]`) may be consumed; the comma class now also covers the
full-width `，` (U+FF0C). 7/7 edge cases pass, +2 regression tests lock it (19 JA tests total).

### F7 — checked and CORRECT as-is: JA exemplars render as greeting + one block

While verifying F6 against the shaper I found every layout profile renders a JA exemplar as
greeting + a single body blob (EN gets the full block pattern). That is a documented, deliberate
carve-out in `layoutShaper.ts`: for scripts where sentence boundaries are unreliable (CJK, Thai...)
the shaper "does the greeting split and blank-line normalization only and never invents a boundary it
cannot see." Consequence worth knowing: JA exemplars cannot demonstrate layout VARIATION to the
writer — the layout directive text carries that alone in JA. Splitting on 。 would be easy but
redistributing CJK sentences is exactly what the carve-out exists to avoid; left as designed.

### F8 — false-positive sweep of the smoke's transliteration list: clean

All 24 kana detection strings checked against all 39 gold exemplars: **0 collisions**, so the smoke
can never flag gold-standard text. The two common legitimate loanwords that LOOK like
transliterations — アンドロイド (Android, established Japanese) and アジャスト (the loan verb stem
アジャストする) — are confirmed absent from the detection list, deliberately.

**Round-3 state: 1,379 tests / 0 failed · build clean · mirror synced.**


---

## 7. H10 RESOLVED — the closing courtesy, in Hidenori's spirit (Michael's call, 2026-08-27)

**The design.** Hidenori's FIXED body ends with `ご確認のほど何卒よろしくお願い申し上げます。` above his
signature block. The two halves get different treatment because they are different things:

- the **closing courtesy (結びの挨拶)** is part of the message body in Japanese — its absence reads
  abrupt → **Japanese bodies now always end with one**;
- the **name/signature lines** are the mail client's job → the stripper's treatment of those is
  unchanged, exactly as B8a intended.

**Mechanism: strip-then-append, not exempt-from-strip.** The old strip list caught
`よろしくお願いいたします` but missed the `何卒…申し上げます` variants, so a JA follow-up ended politely
or abruptly depending on which phrasing the writer happened to emit. Exempting phrases would keep
that lottery. Instead: whatever closing the writer improvises is stripped as before, then
`withJapaneseClosing` appends ONE vetted line — the writer keeps writing content, the deterministic
layer owns the ending, the same division of labour as the layout shaper.

**The set** (all ordinary keigo follow-up closings; the first is Hidenori's own line):

1. `ご確認のほど何卒よろしくお願い申し上げます。`
2. `ご検討のほど、よろしくお願いいたします。`
3. `引き続きよろしくお願いいたします。`
4. `何卒よろしくお願いいたします。`

Rotation is deterministic per (company | subject | stage) — the same seeding idea as the layout
profile — so preview and sent message always agree, and one prospect's three follow-up stages do not
all end with the same courtesy. Idempotent (a body already ending with any set closing gains
nothing), no-op for every non-Japanese language, wired into all three flows and mirrored in the heal
harness's ship-normalization.

**Verified live:** JA heal E2E **2/2 ship clean** with both bodies ending CTA → blank line → closing;
full-pipeline smoke **9/9 clean**; linter confirmed to have no closing rule (so shipped bodies do not
flag); the critic grades the pre-append draft, so its `closing_strip` dimension is undisturbed.
**+6 tests (JA suite now 25), full suite 1,385 / 0.**
