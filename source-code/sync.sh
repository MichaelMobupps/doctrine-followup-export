#!/bin/bash
WORKSPACE="/home/runner/workspace"
DEST="$WORKSPACE/source-code"

sync_dir() {
  local src="$1"
  local dest="$2"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -r "$src"/* "$dest"/ 2>/dev/null
  find "$dest" -name 'node_modules' -type d -exec rm -rf {} + 2>/dev/null
  find "$dest" -name 'dist' -type d -exec rm -rf {} + 2>/dev/null
  find "$dest" -name '*.tsbuildinfo' -delete 2>/dev/null
  find "$dest" -name '*.map' -delete 2>/dev/null
}

sync_dir "$WORKSPACE/artifacts/api-server/src" "$DEST/api-server"
sync_dir "$WORKSPACE/artifacts/api-server/public" "$DEST/api-server-public"
sync_dir "$WORKSPACE/artifacts/dashboard/src" "$DEST/dashboard"
sync_dir "$WORKSPACE/lib/db/src" "$DEST/db"
sync_dir "$WORKSPACE/addon" "$DEST/addon"
sync_dir "$WORKSPACE/doctrine-integration" "$DEST/doctrine-integration"

cp -f "$WORKSPACE/lib/api-spec/openapi.yaml" "$DEST/openapi.yaml"
cp -f "$WORKSPACE/artifacts/api-server/build.mjs" "$DEST/api-server-build.mjs" 2>/dev/null
cp -f "$WORKSPACE/artifacts/api-server/package.json" "$DEST/api-server-package.json" 2>/dev/null
cp -f "$WORKSPACE/artifacts/dashboard/package.json" "$DEST/dashboard-package.json" 2>/dev/null
cp -f "$WORKSPACE/lib/db/package.json" "$DEST/db-package.json" 2>/dev/null

echo "$(date '+%Y-%m-%d %H:%M:%S') - Source code synced successfully"
