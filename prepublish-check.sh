#!/usr/bin/env bash
# Pre-Republish check for the Doctrine Follow-up API.
# Boots the BUILT artifact (exactly what Republish deploys) on a spare port,
# pauses sending so the booted instance's cron cannot send during the test,
# runs smoke-budget.sh against it, restores your prior pause state, and shuts
# the instance down. Run from the workspace where smoke-budget.sh lives.
set -uo pipefail

WORKSPACE="${WORKSPACE:-/home/runner/workspace}"
API_DIR="$WORKSPACE/artifacts/api-server"
SMOKE="$WORKSPACE/smoke-budget.sh"
PT="${PORT_TEST:-3010}"
BASE="http://localhost:$PT"
LOG="/tmp/prepublish_api.log"
AK=(-H "x-api-key: ${ADDON_API_KEY:-}" -H "x-admin-key: ${ADMIN_API_KEY:-}")

fail(){ echo "FATAL: $1"; exit 2; }
[ -f "$API_DIR/dist/index.mjs" ] || fail "$API_DIR/dist/index.mjs not found. Apply the bundle (it builds) first."
[ -f "$SMOKE" ] || fail "smoke-budget.sh not found in $WORKSPACE."
[ -n "${ADMIN_API_KEY:-}" ] || fail "ADMIN_API_KEY not set. Run: ADMIN_API_KEY=<key> ADDON_API_KEY=<key> bash prepublish-check.sh"
[ -n "${ADDON_API_KEY:-}" ] || fail "ADDON_API_KEY not set. Run: ADMIN_API_KEY=<key> ADDON_API_KEY=<key> bash prepublish-check.sh"
if curl -fsS --connect-timeout 1 --max-time 2 "$BASE/api/healthz" >/dev/null 2>&1; then
  fail "port $PT already answers. Use a free one: PORT_TEST=3011 bash prepublish-check.sh"
fi

echo "Booting built API on :$PT ..."
cd "$API_DIR"
PORT="$PT" node --enable-source-maps ./dist/index.mjs >"$LOG" 2>&1 &
API_PID=$!
cd "$WORKSPACE"

PRIOR_PAUSE=""
restore(){
  if [ "$PRIOR_PAUSE" = "false" ]; then
    curl -s --max-time 5 -X POST "${AK[@]}" "$BASE/api/admin/resume-all" >/dev/null 2>&1 || true
    echo "Restored: sending resumed (prior state)."
  elif [ "$PRIOR_PAUSE" = "true" ]; then
    echo "Left sending paused (it was already paused before the test)."
  else
    echo "NOTE: could not read the prior pause state. Sending may be left paused."
    echo "      Verify with: curl -s -H \"x-api-key: \$ADDON_API_KEY\" -H \"x-admin-key: \$ADMIN_API_KEY\" $BASE/api/admin/global-pause   (or resume via /api/admin/resume-all on production after Republish)"
  fi
  kill "$API_PID" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6; do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.5; done
  kill -9 "$API_PID" >/dev/null 2>&1 || true
  wait "$API_PID" 2>/dev/null || true
}
trap restore EXIT

# wait for health (max ~30s)
ready=""
for _ in $(seq 1 60); do
  if curl -fsS --connect-timeout 1 --max-time 2 "$BASE/api/healthz" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$API_PID" 2>/dev/null || { echo "FATAL: the API exited during boot. Last log lines:"; tail -30 "$LOG"; exit 2; }
  sleep 0.5
done
[ -n "$ready" ] || { echo "FATAL: API did not become healthy on :$PT in time. Last log lines:"; tail -30 "$LOG"; exit 2; }

# capture prior global pause, then pause so the booted cron cannot send
PRIOR_PAUSE=$(curl -s --max-time 5 "${AK[@]}" "$BASE/api/admin/global-pause" | python3 -c "import sys,json
try: print(str(json.load(sys.stdin).get('paused','')).lower())
except Exception: print('')")
curl -s --max-time 5 -X POST "${AK[@]}" "$BASE/api/admin/pause-all" >/dev/null 2>&1 || true
echo "Sending paused for the test (prior pause state: ${PRIOR_PAUSE:-unknown})."
echo "================================================================"
PORT="$PT" bash "$SMOKE"; rc=$?
echo "================================================================"
exit $rc
