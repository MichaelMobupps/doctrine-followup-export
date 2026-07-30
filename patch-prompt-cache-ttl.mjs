#!/usr/bin/env node
/**
 * patch-prompt-cache-ttl.mjs
 * ---------------------------------------------------------------------------
 * CB-2 (cost): pin the prompt-cache breakpoint to a 1-hour TTL.
 *
 * WHY: Anthropic changed the DEFAULT ephemeral cache lifetime from 1h to 5m on
 * 6 Mar 2026. cachedSystem() sets cache_control with no explicit ttl, so it
 * inherited 5m. The pipeline runs on a 15-minute cron tick, so every cached
 * prefix expires before the next tick reuses it: you pay the 1.25x cache-WRITE
 * surcharge and never earn a read. That is the "low cache hit rate" the Console
 * flagged. The 1h TTL keeps the doctrine prefix warm across ~4 ticks.
 *
 * WHAT: edits api-server/lib/anthropic.ts only:
 *   - adds an env-overridable `PROMPT_CACHE_TTL` ("1h" default, "5m" to revert)
 *   - sets cache_control = { type: "ephemeral", ttl: PROMPT_CACHE_TTL }
 *
 * SAFE: idempotent (re-running is a no-op), anchored (fails loudly if the
 * source has drifted), behavior-preserving (caching never changes output).
 *
 * RUN:  node patch-prompt-cache-ttl.mjs [path/to/api-server/lib/anthropic.ts]
 *       (defaults to ./api-server/lib/anthropic.ts)
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2] ?? "api-server/lib/anthropic.ts";

let src;
try {
  src = readFileSync(target, "utf8");
} catch {
  console.error(`✗ cannot read ${target}. Pass the path to anthropic.ts as arg 1.`);
  process.exit(2);
}

// --- idempotency guard -----------------------------------------------------
if (src.includes("PROMPT_CACHE_TTL")) {
  console.log("• already patched (PROMPT_CACHE_TTL present) — no-op.");
  process.exit(0);
}

// --- anchor 1: the cache_control assignment --------------------------------
const OLD_LINE = '      block.cache_control = { type: "ephemeral" };';
const NEW_LINE =
  "      // ttl is a first-class, typed field on CacheControlEphemeral in\n" +
  '      // @anthropic-ai/sdk@0.65 (ttl?: "5m" | "1h"), so no cast is needed.\n' +
  "      block.cache_control = { type: \"ephemeral\", ttl: PROMPT_CACHE_TTL };";

// --- anchor 2: the cachedSystem declaration (inject the knob above it) ------
const FUNC_ANCHOR = "export function cachedSystem(";
const KNOB =
  "/**\n" +
  " * CB-2 (cost) — prompt-cache TTL. Default flipped from 1h to 5m by Anthropic\n" +
  " * on 6 Mar 2026; our 15-minute cron tick means a 5m prefix dies before reuse,\n" +
  " * so every call pays the 1.25x write surcharge and never reads. Pin to 1h:\n" +
  " * first call of the hour writes (2x), the next ~4 ticks read (0.1x), and\n" +
  " * reads are exempt from rate-limit accounting. 1h is GA on the API and needs\n" +
  " * no beta header. Override with PROMPT_CACHE_TTL=5m to revert without a code\n" +
  " * change (only sensible if call cadence ever drops below one call per hour).\n" +
  " */\n" +
  'type PromptCacheTtl = "5m" | "1h";\n\n' +
  "export const PROMPT_CACHE_TTL: PromptCacheTtl =\n" +
  '  process.env.PROMPT_CACHE_TTL === "5m" ? "5m" : "1h";\n\n';

// --- verify both anchors exist exactly once --------------------------------
const fail = (m) => {
  console.error(`✗ ${m}\n  Source has drifted from the expected shape; not patching.`);
  process.exit(1);
};
if (src.split(OLD_LINE).length - 1 !== 1) fail(`expected exactly one cache_control line:\n    ${OLD_LINE.trim()}`);
if (src.split(FUNC_ANCHOR).length - 1 !== 1) fail(`expected exactly one "${FUNC_ANCHOR}" declaration`);

// --- apply -----------------------------------------------------------------
let out = src.replace(OLD_LINE, NEW_LINE);
out = out.replace(FUNC_ANCHOR, KNOB + FUNC_ANCHOR);

// --- post-conditions -------------------------------------------------------
if (!out.includes('ttl: PROMPT_CACHE_TTL') || !out.includes("export const PROMPT_CACHE_TTL")) {
  fail("post-condition check failed after edit");
}

writeFileSync(target, out, "utf8");
console.log(`✓ patched ${target}`);
console.log("  + PROMPT_CACHE_TTL export (default \"1h\", PROMPT_CACHE_TTL=5m to revert)");
console.log("  + cache_control now carries ttl: PROMPT_CACHE_TTL");
console.log("  Run `pnpm --filter @workspace/api-server typecheck` to confirm.");
