#!/usr/bin/env bash
# apply.sh — Doctrine Follow-up: widened exemplars + in-region competitor library.
#
# Order (halt on any gate failure):
#   python-zipfile unzip -> backup -> copy files -> typecheck gate -> tests gate
#   -> build -> mirror (source-code/sync.sh) -> success
#
# Run from the project root (the directory that contains artifacts/).
set -euo pipefail

STAMP="$(date '+%Y%m%d%H%M%S')"
STAGE=".dff_apply_stage_${STAMP}"
BACKUP_DIR="backups/dff-exemplar-competitor-${STAMP}"
PAYLOAD="payload.zip"

# 1. Locate the workspace root (the dir containing artifacts/).
if [ -d "/home/runner/workspace/artifacts" ]; then
  WORKSPACE="/home/runner/workspace"
elif [ -d "./artifacts" ]; then
  WORKSPACE="$(pwd)"
else
  echo "ERROR: could not find an artifacts/ directory. Run apply.sh from the project root." >&2
  exit 1
fi
cd "$WORKSPACE"
echo "Workspace: $WORKSPACE"

if [ ! -f "$PAYLOAD" ]; then
  echo "ERROR: $PAYLOAD not found next to apply.sh in $WORKSPACE." >&2
  exit 1
fi

# 2. Unzip the payload with python (unzip is not installed on this container).
echo "Extracting $PAYLOAD ..."
python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$PAYLOAD" "$STAGE"

# 3. Back up any target files that already exist, then copy the staged files in.
echo "Backing up current files to $BACKUP_DIR ..."
mkdir -p "$BACKUP_DIR"
while IFS= read -r rel; do
  if [ -f "$WORKSPACE/$rel" ]; then
    mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
    cp "$WORKSPACE/$rel" "$BACKUP_DIR/$rel"
  fi
done < <(cd "$STAGE" && find . -type f | sed 's|^\./||')

echo "Copying new files into place ..."
cp -r "$STAGE/." "$WORKSPACE/"

# 4. Typecheck gate.
echo "GATE 1/2: typecheck (tsc -b) ..."
( cd artifacts/api-server && pnpm run typecheck )
echo "Typecheck passed."

# 5. Tests gate (new competitor test + writer-provider/exemplar regression).
echo "GATE 2/2: tests ..."
TEST_LOG="$(mktemp)"
set +e
pnpm --filter @workspace/api-server exec tsx --test \
  src/tests/test-competitor-library.ts \
  src/tests/test-competitor-script-lint.ts \
  src/tests/test-writer-provider.ts > "$TEST_LOG" 2>&1
TEST_RC=$?
set -e
tail -20 "$TEST_LOG"
if [ "$TEST_RC" -ne 0 ]; then
  echo "ERROR: tests failed (see output above). Halting before build." >&2
  exit 1
fi
echo "Tests passed."

# 6. Build (api-server only; @workspace/db has no build script and is untouched).
echo "Building api-server ..."
( cd artifacts/api-server && pnpm run build )
echo "Build passed."

# 7. Mirror the review tree (post-gates only).
if [ -f "source-code/sync.sh" ]; then
  echo "Syncing source-code mirror ..."
  bash source-code/sync.sh
fi

# 8. Done.
rm -rf "$STAGE"
echo ""
echo "SUCCESS. Backups: $BACKUP_DIR"
echo "Next: Restart, then Republish (separate steps)."
