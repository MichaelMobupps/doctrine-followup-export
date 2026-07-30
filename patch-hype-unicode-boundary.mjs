#!/usr/bin/env node
/**
 * patch-hype-unicode-boundary.mjs  (CORRECTION to patch-lint-falsepositives.mjs)
 *
 * The earlier isLatin widening routed diacritic-bearing hype adjectives to the
 * word-boundary branch, but that branch used ASCII word-boundary anchors, which
 * mis-anchor on adjectives that START or END with a diacritic. Result: the
 * matcher silently MISSED real hype (Turkish onemli/oncu/guclu/olaganustu,
 * Hungarian kivalo/vezeto, and cs/pl/ro equivalents) - a false-NEGATIVE
 * regression, worse than the false positive the original fix removed.
 *
 * This swaps the ASCII boundary for Unicode-aware p{L} lookarounds. Diacritic-
 * bounded adjectives match again, inflections still match, and a stem inside a
 * longer word still does NOT match (megerositett stays clean). Verified against
 * the real findHypeAdjectivesInBody on the hu and tr lists.
 *
 * SAFE: idempotent, anchored. RUN (from ~/workspace):
 *   node patch-hype-unicode-boundary.mjs [path/to/doctrineRules.ts]
 */
import { readFileSync, writeFileSync } from "node:fs";

const B = String.fromCharCode(92); // a single backslash, built explicitly

const target = process.argv[2] ?? "artifacts/api-server/src/lib/doctrineRules.ts";
let src;
try { src = readFileSync(target, "utf8"); }
catch { console.error(`cannot read ${target}. Pass the path as arg 1.`); process.exit(2); }

const MARKER = "(?<![" + B + B + "p{L}";
if (src.includes(MARKER)) { console.log("- already corrected - no-op."); process.exit(0); }

// File line value: "\\b" + escaped + "[a-z\\u00e0-\\u00ff]{0,4}\\b",  (each \\ = 2 chars)
const OLD = '"' + B + B + 'b" + escaped + "[a-z' + B + B + 'u00e0-' + B + B + 'u00ff]{0,4}' + B + B + 'b",';
const NEW = '"(?<![' + B + B + 'p{L}' + B + B + 'p{N}_])" + escaped + "[' + B + B + 'p{L}]{0,4}(?![' + B + B + 'p{L}' + B + B + 'p{N}_])",';

const n = src.split(OLD).length - 1;
if (n !== 1) { console.error(`expected exactly one ASCII boundary hype regex, found ${n}. Drifted; not patching.`); process.exit(1); }

src = src.replace(OLD, NEW);
if (!src.includes(MARKER)) { console.error("post-condition failed"); process.exit(1); }
writeFileSync(target, src, "utf8");
console.log(`+ patched ${target}`);
console.log("  hype matcher now uses Unicode p{L} boundaries (no false negatives on diacritic-bounded adjectives)");
