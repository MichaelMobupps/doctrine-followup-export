#!/usr/bin/env bash
#
# Company-Reply Cascade — QA harness runner.
#
# Copies the harness into the api-server package, runs it once through tsx
# against the app's own database connection, then removes it. No admin API
# key, no HTTP call, no credential on the command line. The harness seeds
# synthetic rows at an isolated fake domain and deletes them when it finishes.
#
# Run ONE command in the Replit shell (see the chat). Exit 0 means every
# assertion passed.

set -u

WORKSPACE="${WORKSPACE:-/home/runner/workspace}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$WORKSPACE/artifacts/api-server"
DEST_DIR="$PKG/src/scripts"
DEST="$DEST_DIR/cascade-qa.ts"

[ -d "$PKG" ] || { echo "RUNNER HALTED: api-server package not found at $PKG"; exit 1; }
[ -f "$SCRIPT_DIR/cascade-qa.ts" ] || { echo "RUNNER HALTED: cascade-qa.ts not found next to runner"; exit 1; }

echo "==> Placing harness in $DEST"
mkdir -p "$DEST_DIR"
cp "$SCRIPT_DIR/cascade-qa.ts" "$DEST"

cleanup_file() {
  rm -f "$DEST"
  rmdir "$DEST_DIR" 2>/dev/null || true
}
trap cleanup_file EXIT

echo "==> Running cascade QA harness (development database)"
echo ""
cd "$WORKSPACE" || { echo "RUNNER HALTED: cannot cd to workspace"; exit 1; }
pnpm --filter @workspace/api-server exec tsx src/scripts/cascade-qa.ts
RC=$?

echo ""
if [ "$RC" -eq 0 ]; then
  echo "==> QA RESULT: PASS (all assertions green). Synthetic rows removed."
else
  echo "==> QA RESULT: FAIL or ERROR (exit $RC). See output above. Synthetic rows are removed by the harness; if it errored hard, remove rows where batch_label starts with __QA_CASCADE_."
fi
exit $RC
