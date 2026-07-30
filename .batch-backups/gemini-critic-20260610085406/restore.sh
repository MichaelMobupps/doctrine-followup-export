#!/usr/bin/env bash
set -euo pipefail
API_SRC="/home/runner/workspace/artifacts/api-server/src"
BK="/home/runner/workspace/.batch-backups/gemini-critic-20260610085406"
cp "$BK/lib/pricing.ts"            "$API_SRC/lib/pricing.ts"
cp "$BK/lib/usageTracker.ts"       "$API_SRC/lib/usageTracker.ts"
cp "$BK/services/followupGenerator.ts" "$API_SRC/services/followupGenerator.ts"
rm -f "$API_SRC/lib/gemini.ts" "$API_SRC/services/criticProvider.ts"
echo "Rolled back the Gemini critic batch. Rebuild before Restart."
