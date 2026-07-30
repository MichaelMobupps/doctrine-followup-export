#!/usr/bin/env bash
# Static smoke (v1.1) for the Followupper Reddit angle. Zero cost, no model calls.
set -uo pipefail
FILE="${FOLLOWUP_FILE:-}"; CTX="${CONTEXT_FILE:-}"
if [ -z "${FILE}" ]; then
  for c in artifacts/api-server/services/followupPrompts.ts api-server/services/followupPrompts.ts source-code/api-server/services/followupPrompts.ts; do
    [ -f "$c" ] && FILE="$c" && break
  done
fi
[ -z "${CTX}" ] && CTX="$(dirname "${FILE}")/contextFollowupPrompts.ts"
[ -f "${FILE}" ] || { echo "FAIL: followupPrompts.ts not found"; exit 1; }
fails=0
pass(){ printf '  PASS  %s\n' "$1"; }
fail(){ printf '  FAIL  %s\n' "$1"; fails=$((fails+1)); }
has(){ grep -qF "$2" "$1"; }
no(){ grep -qF "$2" "$1"; }
echo "Followupper Reddit angle — static smoke (v1.1)"; echo "file: ${FILE}"
has "${FILE}" "REDDIT GOLD AGENCY PARTNER"                                        && pass "angle marker present"                || fail "angle marker missing"
has "${FILE}" "Express it in one short, human line that adds a single new point." && pass "v1.1 positive-spec line present"     || fail "v1.1 positive-spec line missing"
if no "${FILE}" "human line, never a full re-pitch"; then fail "old comma-negation phrase still present"; else pass "old comma-negation phrase removed"; fi
has "${FILE}" "United States, Canada, United Kingdom, Ireland"                    && pass "geo allow-list present"             || fail "geo allow-list missing"
has "${FILE}" "China, Hong Kong, Russia, Belarus"                                 && pass "hard-omit geo list present"         || fail "hard-omit geo list missing"
has "${FILE}" "never claim or imply that advertising through MobUpps influences"  && pass "AI-overclaim guardrail present"     || fail "AI-overclaim guardrail missing"
has "${FILE}" 'keep "Reddit" in Latin script'                                     && pass "Latin-Reddit rule present"          || fail "Latin-Reddit rule missing"
has "${FILE}" "Infer the market from the original email content and the language" && pass "market-inference instruction present"|| fail "market-inference instruction missing"
if [ -f "${CTX}" ]; then
  if grep -qF "REDDIT GOLD AGENCY PARTNER" "${CTX}"; then fail "context-nudge path WAS modified (must be clean)"; else pass "context-nudge path untouched"; fi
else echo "  WARN  contextFollowupPrompts.ts not found at ${CTX} (skipped)"; fi
TICKS=$(grep -o '`' "${FILE}" | wc -l | tr -d ' ')
if [ $((TICKS % 2)) -eq 0 ]; then pass "backtick parity even (${TICKS})"; else fail "backtick parity odd (${TICKS})"; fi
echo
if [ "${fails}" -eq 0 ]; then echo "STATIC SMOKE: PASS"; exit 0; else echo "STATIC SMOKE: ${fails} FAILED"; exit 1; fi
