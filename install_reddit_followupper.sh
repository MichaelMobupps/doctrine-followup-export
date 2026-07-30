#!/usr/bin/env bash
# ============================================================================
# Followupper — Reddit Gold Agency Partner angle installer
# ----------------------------------------------------------------------------
# Inserts one conditional Reddit angle into getFollowupSystemPrompt in
# followupPrompts.ts, in place and idempotently. Leaves the context-nudge path
# (contextFollowupPrompts.ts) untouched, since that path forbids new value
# propositions. No critic, lint, or logic change.
#
# Gates (project-agnostic, guaranteed to run):
#   1. marker present after patch
#   2. backtick parity even  (TS template literals still balanced)
#   3. optional TypeScript syntax check, if the project's typescript resolves
# Order: locate -> backup -> patch -> gates. Halts on any failure with a
# one-line restore command.
# ============================================================================
set -euo pipefail

ROOT="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="${ROOT}/.reddit_fu_backup_${STAMP}"

say() { printf '\n>>> %s\n' "$*"; }
die() { printf '\n!!! HALT: %s\n' "$*" >&2; exit 1; }

[ -f "apply_reddit_followupper.py" ] || die "apply_reddit_followupper.py not found next to this script."

# --- 0. locate followupPrompts.ts -----------------------------------------
FILE="${FOLLOWUP_FILE:-}"
if [ -z "${FILE}" ]; then
  for c in artifacts/api-server/services/followupPrompts.ts \
           api-server/services/followupPrompts.ts \
           source-code/api-server/services/followupPrompts.ts; do
    [ -f "$c" ] && FILE="$c" && break
  done
fi
[ -n "${FILE}" ] && [ -f "${FILE}" ] || die "followupPrompts.ts not found.
    Run from the repo root, or set FOLLOWUP_FILE to its path."
say "Target: ${FILE}"

# --- 1. backup ------------------------------------------------------------
say "1/4 Backup -> ${BACKUP}/"
mkdir -p "${BACKUP}"
cp -p "${FILE}" "${BACKUP}/followupPrompts.ts"

# --- 2. patch (idempotent, anchored, self-verifies backtick parity) -------
say "2/4 Inserting the Reddit angle"
FOLLOWUP_FILE="${FILE}" python3 apply_reddit_followupper.py

# --- 3. marker gate -------------------------------------------------------
say "3/4 Marker gate"
grep -q "REDDIT GOLD AGENCY PARTNER" "${FILE}" \
  || die "marker missing after patch. Restore: cp -p ${BACKUP}/followupPrompts.ts ${FILE}"

# --- 4. template-literal balance + optional TS syntax gate ----------------
say "4/4 Template-literal + syntax gate"
TICKS=$(grep -o '`' "${FILE}" | wc -l | tr -d ' ')
[ $((TICKS % 2)) -eq 0 ] \
  || die "backtick parity is odd (${TICKS}); template literal broken. Restore: cp -p ${BACKUP}/followupPrompts.ts ${FILE}"
echo "    backtick parity even (${TICKS})"

# Optional TS syntax-only check, if typescript is resolvable in this repo.
TS_NODE_PATH=""
for nm in node_modules artifacts/api-server/node_modules api-server/node_modules; do
  [ -d "$nm/typescript" ] && TS_NODE_PATH="$ROOT/$nm" && break
done
if [ -n "${TS_NODE_PATH}" ]; then
  NODE_PATH="${TS_NODE_PATH}" node -e '
    const ts=require("typescript"), fs=require("fs");
    const src=fs.readFileSync(process.argv[1],"utf8");
    const out=ts.transpileModule(src,{reportDiagnostics:true,compilerOptions:{module:"ESNext",target:"ES2020"}});
    const syn=(out.diagnostics||[]).filter(d=>d.category===1);
    if(syn.length){console.error("SYNTAX ERRORS: "+syn.map(d=>ts.flattenDiagnosticMessageText(d.messageText,"\n")).join("; "));process.exit(2);}
    console.log("    TS syntax OK");
  ' "${FILE}" || die "TS syntax check failed. Restore: cp -p ${BACKUP}/followupPrompts.ts ${FILE}"
else
  echo "    (typescript not resolved here; backtick parity gate stands. Run pnpm typecheck below.)"
fi

say "DONE — Reddit angle inserted and verified."
echo "    Backup:  ${BACKUP}/"
echo "    Revert:  cp -p ${BACKUP}/followupPrompts.ts ${FILE}"
echo
echo "    Monorepo follow-on (run these in your normal Followupper flow):"
echo "      1. pnpm typecheck"
echo "      2. vitest run (the followup + doctrine tests); read with: ... 2>&1 | tail -20"
echo "      3. bash scripts/sync-source-code.sh   (mirror artifacts -> source-code)"
echo "      4. build, restart, then Republish to ship to production"
