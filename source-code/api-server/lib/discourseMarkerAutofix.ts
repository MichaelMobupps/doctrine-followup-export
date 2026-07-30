/**
 * discourseMarkerAutofix.ts — v4 Round-4 hardening.
 *
 * Deterministic auto-fix for REPEATING-DISCOURSE-MARKER violations.
 * For each duplicate marker, keep the FIRST occurrence intact and strip
 * subsequent occurrences plus any trailing complementizer
 * ("que" in PT/ES/FR, "che" in IT, "dass" in DE, "that" in EN, etc.).
 *
 * Example:
 *   Input:  "Vale mencionar que A. Vale mencionar que B opera."
 *   Output: "Vale mencionar que A. B opera."
 */

import {
  findRepeatingDiscourseMarkers,
} from "./nativenessV4";

// ============================================================================
// Per-language complementizers
// ============================================================================

export const COMPLEMENTIZERS: Readonly<Record<string, readonly string[]>> = {
  en: ["that"],
  pt: ["que"],
  "pt-BR": ["que"],
  es: ["que"],
  fr: ["que", "qu'"],
  it: ["che"],
  de: ["dass", "daß"],
  nl: ["dat"],
  ru: ["что"],
  uk: ["що"],
  pl: ["że"],
  cs: ["že"],
  sv: ["att"],
  no: ["at"],
  nb: ["at"],
  da: ["at"],
  fi: ["että"],
  hu: ["hogy"],
  ro: ["că"],
  tr: ["ki"],
  ar: ["أن", "أنه", "بأن"],
  he: ["ש", "כי", "שכן"],
  fa: ["که"],
  hi: ["कि"],
  bn: ["যে"],
  ur: ["کہ"],
  th: ["ว่า"],
  vi: ["rằng"],
  id: ["bahwa"],
  ms: ["bahawa"],
  fil: ["na", "ng"],
  ja: [],
  zh: [],
  ko: [],
  el: ["ότι"],
};


function getComplementizers(lang: string): readonly string[] {
  const langN = (lang || "").trim().toLowerCase();
  if (langN in COMPLEMENTIZERS) return COMPLEMENTIZERS[langN];
  const base = langN.includes("-") ? langN.split("-")[0] : langN;
  return COMPLEMENTIZERS[base] || [];
}


export interface AutofixResult {
  fixedText: string;
  fixes: string[];
}


/**
 * Deterministically remove duplicate discourse-marker openers.
 *
 * For each marker appearing 2+ times, keep the FIRST occurrence intact
 * and remove subsequent occurrences plus any trailing complementizer +
 * punctuation + whitespace. Capitalizes the following word if it started
 * lowercase.
 *
 * Safe to call on any text — returns the input unchanged if no duplicates
 * exist. Never throws.
 */
export function autoFixRepeatingDiscourseMarkers(
  text: string,
  lang: string,
): AutofixResult {
  if (!text) return { fixedText: text, fixes: [] };

  let hits;
  try {
    hits = findRepeatingDiscourseMarkers(text, lang);
  } catch {
    return { fixedText: text, fixes: [] };
  }

  if (!hits || hits.length === 0) {
    return { fixedText: text, fixes: [] };
  }

  const fixes: string[] = [];
  const complementizers = getComplementizers(lang);

  // Process longest markers first
  const sorted = [...hits].sort(
    (a, b) => (b.marker?.length || 0) - (a.marker?.length || 0)
  );

  let workingText = text;

  for (const hit of sorted) {
    const marker = hit.marker || "";
    if (!marker) continue;

    // Build pattern: marker as standalone phrase (word-boundary aware)
    const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(?<![\\w])${escapedMarker}(?![\\w])`,
      "gi"
    );

    const matches: RegExpExecArray[] = [];
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(workingText)) !== null) {
      matches.push(m);
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }

    if (matches.length < 2) continue;

    // Process from right to left so earlier offsets stay valid
    for (let i = matches.length - 1; i >= 1; i--) {
      const match = matches[i];
      const start = match.index;
      const end = match.index + match[0].length;

      let extEnd = end;
      // Loop until nothing more can be consumed.  Languages differ in the
      // order of punctuation/complementizer (DE: ", dass"; PT/EN: "que/that"
      // then comma).  The loop lets each pass consume one category and try again.
      let changed = true;
      while (changed) {
        changed = false;
        // Whitespace
        while (extEnd < workingText.length && /[ \t]/.test(workingText[extEnd])) {
          extEnd++;
          changed = true;
        }
        // Complementizer
        for (const comp of complementizers) {
          if (extEnd + comp.length <= workingText.length) {
            const candidate = workingText.substring(extEnd, extEnd + comp.length);
            const boundaryAfter = extEnd + comp.length;
            const boundaryOk =
              boundaryAfter >= workingText.length ||
              !/\w/.test(workingText[boundaryAfter]);
            if (candidate.toLowerCase() === comp.toLowerCase() && boundaryOk) {
              extEnd += comp.length;
              changed = true;
              break;
            }
          }
        }
        // Punctuation
        if (extEnd < workingText.length && /[,:;]/.test(workingText[extEnd])) {
          extEnd++;
          changed = true;
        }
      }

      // Capitalize next char if lowercase
      let replacement: string;
      if (extEnd < workingText.length) {
        const nextCh = workingText[extEnd];
        if (/[a-zà-ÿа-я]/.test(nextCh) && nextCh === nextCh.toLowerCase()) {
          replacement = nextCh.toUpperCase() + workingText.substring(extEnd + 1);
        } else {
          replacement = workingText.substring(extEnd);
        }
      } else {
        replacement = "";
      }

      workingText = workingText.substring(0, start) + replacement;

      fixes.push(
        `Removed duplicate '${marker}' at offset ${start} ` +
        `(consumed ${extEnd - start} chars)`
      );
    }
  }

  return { fixedText: workingText, fixes };
}


/** Helper for tests: total duplicate marker hits detected. */
export function countDuplicateMarkerHits(text: string, lang: string): number {
  if (!text) return 0;
  try {
    const hits = findRepeatingDiscourseMarkers(text, lang);
    return hits ? hits.length : 0;
  } catch {
    return 0;
  }
}
