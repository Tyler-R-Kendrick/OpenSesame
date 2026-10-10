#!/usr/bin/env bash
# Re-run Kimi investigation (wave 2+) after headless prompt fix. Subscription only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
LOG="${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
export PATH="${HOME}/.local/bin:${PATH}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

exec >>"$LOG" 2>&1
echo "=== reinvestigate wave $WAVE start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
if ! DEEPSEC_REINVESTIGATE_WAVE="$WAVE" "${ROOT}/scripts/audit/deepsec-wave2-process.sh"; then
  echo "=== reinvestigate wave $WAVE paused (no agent) $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  exit 0
fi
echo "=== reinvestigate wave $WAVE done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
