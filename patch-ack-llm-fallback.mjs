#!/usr/bin/env node
/**
 * patch-ack-llm-fallback.mjs
 * ---------------------------------------------------------------------------
 * Wires the FOLLOWUP-ACK LLM confirmation (lib/followupAckConfirm.ts) into the
 * production heal loop in services/followupGenerator.ts.
 *
 * The deterministic FOLLOWUP-ACK regex tables false-positive on correct emails
 * across many languages, forcing needless rewrites. After this patch, when the
 * regex layer flags FOLLOWUP-ACK the loop calls a cheap Haiku yes/no to confirm
 * the opening really lacks a prior-outreach reference. Confirmed false positives
 * are dropped before deciding needs_rewrite. Fail-open conservative: on any
 * error or a non-YES answer the flag stands, so behavior is never worse than
 * today. Disable with FOLLOWUP_ACK_LLM_CONFIRM=0.
 *
 * Prereq: lib/followupAckConfirm.ts must already be present in the same lib dir.
 *
 * Edits services/followupGenerator.ts only:
 *   - add the import
 *   - rename the raw merge to deterministicCheck0
 *   - insert: deterministicCheck = await dropFalseFollowupAck(deterministicCheck0, ...)
 *
 * SAFE: idempotent, anchored (refuses on drift). RUN (from ~/workspace):
 *   node patch-ack-llm-fallback.mjs [path/to/followupGenerator.ts]
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2] ?? "artifacts/api-server/src/services/followupGenerator.ts";

let src;
try { src = readFileSync(target, "utf8"); }
catch { console.error(`✗ cannot read ${target}. Pass the path as arg 1.`); process.exit(2); }

if (src.includes("dropFalseFollowupAck")) {
  console.log("• already wired (dropFalseFollowupAck present) — no-op.");
  process.exit(0);
}

const fail = (m) => { console.error(`✗ ${m}\n  Source drifted; not patching.`); process.exit(1); };
const once = (s, anchor, label) => {
  if (s.split(anchor).length - 1 !== 1) fail(`${label}: expected exactly one anchor`);
  return true;
};

// 1) import (anchor on the competitor-script lint import that sits beside it)
const IMPORT_ANCHOR = 'import { detectCompetitorScriptViolations } from "../lib/competitorScriptLint";';
once(src, IMPORT_ANCHOR, "import anchor");
src = src.replace(
  IMPORT_ANCHOR,
  IMPORT_ANCHOR + '\nimport { dropFalseFollowupAck } from "../lib/followupAckConfirm";',
);

// 2) rename the raw merge target
const RENAME_ANCHOR = "    const deterministicCheck = mergeViolationReports(";
once(src, RENAME_ANCHOR, "merge anchor");
src = src.replace(RENAME_ANCHOR, "    const deterministicCheck0 = mergeViolationReports(");

// 3) insert the filter right after the merge block closes
const CLOSE_ANCHOR =
  "      detectCompetitorScriptViolations(current.body, ctx.original_language),\n    );";
once(src, CLOSE_ANCHOR, "merge-close anchor");
src = src.replace(
  CLOSE_ANCHOR,
  CLOSE_ANCHOR +
    "\n    // FOLLOWUP-ACK false-positive guard: confirm with a cheap LLM check\n" +
    "    // before treating a regex ACK miss as a real violation. Fail-open.\n" +
    "    const deterministicCheck = await dropFalseFollowupAck(\n" +
    "      deterministicCheck0,\n" +
    "      current.body,\n" +
    "      ctx.original_language,\n" +
    "    );",
);

if (!src.includes("dropFalseFollowupAck(") || !src.includes("deterministicCheck0")) {
  fail("post-condition check failed");
}

writeFileSync(target, src, "utf8");
console.log(`✓ patched ${target}`);
console.log("  + import dropFalseFollowupAck");
console.log("  + deterministicCheck now passes through the LLM false-positive guard");
console.log("  Run `pnpm --filter @workspace/api-server typecheck` to confirm.");
