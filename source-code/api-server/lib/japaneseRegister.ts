/**
 * japaneseRegister.ts — deterministic Japanese register normalization.
 *
 * WHY THIS IS DETERMINISTIC AND NOT A PROMPT RULE
 *
 * A native review (Hidenori Terao, MobUpps BD, Aug 2026 — Hidenori.pdf) changed
 * 当社 → 弊社 and 貴社 → 御社 throughout a Japanese outreach email. Both are
 * register errors rather than mistakes: the wrong word is a real word that means
 * the right thing, just in the wrong politeness or medium register, so nothing
 * downstream flags it and a non-speaker cannot see it.
 *
 * The rule was first added to the prompt layer (nativenessV4 register_notes and
 * the JA nativeness guide). It was not enough: with the rule live, a 9-cell
 * deterministic smoke across three verticals and all three stages still found
 * 貴社 in 4 of 9 generated bodies — 44%. Prompt rules move a model's tendencies;
 * they do not guarantee a substitution. This module does.
 *
 * WHY THE SUBSTITUTIONS ARE SAFE
 *
 *   当社 → 弊社   Both mean "our company". 当社 is neutral/corporate and reads as
 *                internal or press-release voice. 弊社 is 謙譲語 (humble) and is
 *                what outbound Japanese sales is written in. Same length, same
 *                grammatical slot, no particle changes.
 *   貴社 → 御社   Both mean "your company". 貴社 is the written-document form
 *                (contracts, formal letters); 御社 is the spoken and email form.
 *                In an email 貴社 reads stiff and slightly wrong. Same length,
 *                same slot.
 *
 * Neither substitution can change meaning, agreement, or particle usage, which
 * is what makes a blind global replace correct here — and is why the same
 * treatment is NOT applied to any other language's register choices, where the
 * equivalent pairs are not interchangeable.
 *
 * This is the same normalization applied to the stored JA exemplars at render
 * time (lib/exemplarLibrary.ts), so what the writer is shown and what the writer
 * ships obey one rule.
 */

/** Language tags that get Japanese register normalization. */
function isJapanese(languageTag: string | null | undefined): boolean {
  if (!languageTag) return false;
  return /^ja\b/i.test(languageTag.trim());
}

/**
 * Apply the register substitutions to Japanese text. Pure and idempotent.
 *
 * Deliberately unconditional on language — the caller decides. Exported this way
 * so the exemplar renderer (which already knows the exemplar is JA) and the
 * output path (which has a language tag) can share one implementation.
 */
export function normalizeJapaneseRegister(text: string): string {
  return text.replace(/当社/g, "弊社").replace(/貴社/g, "御社");
}

/**
 * Remove the trailing comma after a 様 salutation.
 *
 * Japanese does not punctuate a salutation. "カワマタ様," is the English
 * "Hi Alex," shape imported wholesale, and all 39 stored JA exemplars taught it
 * before this was fixed at render time. Handles the ASCII comma the writer
 * copies from English, the 読点 「、」, and the full-width comma 「，」. Scoped to
 * end-of-line so a 様 inside a sentence is untouched.
 *
 * ONLY HORIZONTAL whitespace ([ \t]) may be consumed around the comma. The
 * first version used \s*, which matches newlines — so on a SHAPED body
 * ("カワマタ様,\n\n本文…") the match swallowed the first newline and the
 * replacement collapsed the blank line the layout shaper had just guaranteed,
 * recreating the exact robotic-layout defect of the 2026-08-26 incident on any
 * Japanese draft whose writer emitted the comma. In production this runs AFTER
 * the shaper, so nothing downstream would have repaired it.
 */
export function normalizeJapaneseSalutation(text: string): string {
  return text.replace(/(様)[ \t]*[,、，][ \t]*(?=\r?\n|$)/gm, "$1");
}

/**
 * The full Japanese normalization applied to a body, gated on language.
 * A no-op for every other language, so it is safe to call unconditionally on
 * any return path.
 */
export function applyJapaneseRegister(
  body: string,
  languageTag: string | null | undefined,
): string {
  if (!isJapanese(languageTag)) return body;
  return normalizeJapaneseSalutation(normalizeJapaneseRegister(body));
}

// ---------------------------------------------------------------------------
// The Japanese closing courtesy (結びの挨拶).
// ---------------------------------------------------------------------------

/**
 * Closing courtesy lines for a Japanese FOLLOW-UP, appended deterministically.
 *
 * WHY JAPANESE GETS A CLOSING WHEN EVERY OTHER LANGUAGE HAS THEM STRIPPED
 *
 * B8a strips closing lines because the mail client appends the sender's
 * signature, and in English "Best regards, Michael" is redundant with it. In
 * Japanese that reasoning does not hold: the 結びの挨拶 is not a signature —
 * it is the closing courtesy of the message body, and its absence reads as
 * abrupt. The native review that drove the Aug 2026 Japanese work (Hidenori
 * Terao — Hidenori.pdf) ends its FIXED body with exactly such a line, ABOVE
 * the signature block. His signature lines are still the mail client's job,
 * so the stripper's treatment of name lines is unchanged.
 *
 * WHY APPEND-AFTER-STRIP RATHER THAN EXEMPT-FROM-STRIP
 *
 * Before this, the strip list caught よろしくお願いいたします but missed the
 * 何卒…申し上げます variants — so a Japanese follow-up ended politely or
 * abruptly depending on which phrasing the writer happened to emit. Exempting
 * phrases would keep that lottery (and keep the writer's occasional trailing
 * name line alive under a kept closing). Stripping everything and appending
 * one known-good line gives exactly one closing, in a vetted native form, with
 * no name line, every time. The writer keeps being told not to write closings;
 * the deterministic layer owns the ending — the same division of labour as the
 * layout shaper.
 *
 * The set is small and rotates deterministically (seeded like the layout
 * profile) so a prospect who gets three follow-ups does not see the same
 * closing three times. All four are ordinary keigo follow-up closings a native
 * salesperson would write; the first is the native reviewer's own line.
 */
export const JAPANESE_CLOSINGS: readonly string[] = [
  "ご確認のほど何卒よろしくお願い申し上げます。",
  "ご検討のほど、よろしくお願いいたします。",
  "引き続きよろしくお願いいたします。",
  "何卒よろしくお願いいたします。",
];

/** Stable non-crypto hash for closing rotation. Mirrors the layout seeding idea. */
function seedHash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Append the deterministic closing courtesy to a Japanese body.
 *
 * - No-op for non-Japanese languages.
 * - Idempotent: if the body already ends with any closing from the set (the
 *   function ran before, or a future exemplar teaches one), nothing is added.
 * - `seed` should be stable per thread-and-stage (company + subject + stage),
 *   so a regenerated draft, the dashboard preview and the sent message agree,
 *   and consecutive stages in one thread rotate.
 *
 * Runs AFTER stripClosingFromBody, the layout shaper and the register
 * normalizer, so it appends onto a finished body and is not itself reshaped.
 */
export function withJapaneseClosing(
  body: string,
  languageTag: string | null | undefined,
  seed: string,
): string {
  if (!/^ja\b/i.test((languageTag ?? "").trim())) return body;
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) return body;
  for (const closing of JAPANESE_CLOSINGS) {
    if (trimmed.endsWith(closing)) return trimmed;
  }
  const pick = JAPANESE_CLOSINGS[seedHash(seed) % JAPANESE_CLOSINGS.length];
  return `${trimmed}\n\n${pick}`;
}
