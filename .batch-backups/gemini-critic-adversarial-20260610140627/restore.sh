#!/usr/bin/env bash
set -euo pipefail
cp "/home/runner/workspace/.batch-backups/gemini-critic-adversarial-20260610140627/services/followupGenerator.ts" "/home/runner/workspace/artifacts/api-server/src/services/followupGenerator.ts"
rm -f "/home/runner/workspace/artifacts/api-server/src/scripts/adversarial-critic.ts"
echo "Rolled back the adversarial battery. Rebuild before Restart."
