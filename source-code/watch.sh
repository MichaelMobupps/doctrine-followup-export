#!/bin/bash
WORKSPACE="/home/runner/workspace"
SCRIPT="$WORKSPACE/source-code/sync.sh"

echo "Starting source-code watcher..."
bash "$SCRIPT"

while true; do
  inotifywait -r -q -e modify,create,delete,move \
    --exclude '(node_modules|dist|\.tsbuildinfo|source-code)' \
    "$WORKSPACE/artifacts/api-server/src" \
    "$WORKSPACE/artifacts/api-server/public" \
    "$WORKSPACE/artifacts/dashboard/src" \
    "$WORKSPACE/lib/db/src" \
    "$WORKSPACE/addon" \
    "$WORKSPACE/doctrine-integration" \
    "$WORKSPACE/lib/api-spec/openapi.yaml" \
    2>/dev/null

  sleep 2
  bash "$SCRIPT"
done
