#!/usr/bin/env bash
set -euo pipefail
[ -f "/home/runner/workspace/.batch-backups/gemini-critic-retry-20260610110137/lib/gemini.ts" ] && cp "/home/runner/workspace/.batch-backups/gemini-critic-retry-20260610110137/lib/gemini.ts" "/home/runner/workspace/artifacts/api-server/src/lib/gemini.ts"
[ -f "/home/runner/workspace/.batch-backups/gemini-critic-retry-20260610110137/scripts/smoke-critic.ts" ] && cp "/home/runner/workspace/.batch-backups/gemini-critic-retry-20260610110137/scripts/smoke-critic.ts" "/home/runner/workspace/artifacts/api-server/src/scripts/smoke-critic.ts"
echo "Rolled back the Gemini retry fix. Rebuild before Restart."
