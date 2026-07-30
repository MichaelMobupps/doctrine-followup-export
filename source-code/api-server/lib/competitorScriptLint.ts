/**
 * Deterministic competitor-script lint.
 *
 * Flags a competitor brand that appears in Latin inside a non-Latin-script email
 * when a verified native-script form exists for that language. It runs in the
 * same deterministic layer as the doctrine and structural linters, so a hit
 * triggers a rewrite (and, under the cost gate, skips the Opus critic), and the
 * issue and suggestion reach the rewriter in the usual channel.
 *
 * Scope is intentionally narrow to avoid false positives: only brands present in
 * BRAND_NATIVE_FORMS for a STRICT_NATIVE_LANGS language are checked, and a brand
 * is flagged only when its Latin form is present and its native form is absent.
 * Latin-keep brands carry no native form, so they are never flagged.
 */
import type { ViolationReport } from "./doctrineLint";
import { BRAND_NATIVE_FORMS, isStrictNativeLang } from "./competitorNativeForms";

const EMPTY: ViolationReport = { found: false, issues: [], suggestions: [], matches: [] };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function detectCompetitorScriptViolations(body: string, languageTag: string): ViolationReport {
  const lang = (languageTag || "").toLowerCase().split(/[-_]/)[0];
  if (!isStrictNativeLang(lang)) return EMPTY;
  const map = BRAND_NATIVE_FORMS[lang];
  if (!map) return EMPTY;

  const issues: string[] = [];
  const suggestions: string[] = [];
  const matches: string[] = [];

  for (const [latin, native] of Object.entries(map)) {
    // Boundary on Unicode letters so a Latin brand token surrounded by native
    // script is matched, while a Latin substring inside a longer Latin word is
    // not. Case-insensitive so Ozon/ozon/OZON all match.
    const re = new RegExp(`(?<!\\p{L})${escapeRegExp(latin)}(?!\\p{L})`, "iu");
    if (re.test(body) && !body.includes(native)) {
      issues.push(
        `COMPETITOR SCRIPT: the brand "${latin}" appears in Latin but must be written as "${native}" in ${lang} B2B copy.`,
      );
      suggestions.push(`Replace "${latin}" with "${native}".`);
      matches.push(`${latin}→${native}`);
    }
  }

  if (issues.length === 0) return EMPTY;
  return { found: true, issues, suggestions, matches };
}
