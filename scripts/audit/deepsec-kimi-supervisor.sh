#!/usr/bin/env bash
# Long-lived supervisor: 25-minute ticks until finish exports with errors near zero.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG=/tmp/deepsec-kimi-supervisor.log
INTERVAL="${DEEPSEC_SUPERVISOR_INTERVAL_SEC:-1500}"
exec >>"$LOG" 2>&1
echo "=== supervisor start $(date -u +%Y-%m-%dT%H:%M:%SZ) interval=${INTERVAL}s ==="
while true; do
  "${ROOT}/scripts/audit/deepsec-kimi-monitor-tick.sh" || true
  errs=$(cd "${ROOT}/.deepsec" && "${ROOT}/.deepsec/node_modules/.bin/deepsec" status --project-id opensesame 2>/dev/null \
    | grep -E '^[[:space:]]+error:' | head -1 | sed 's/.*error:[[:space:]]*//' | tr -dc '0-9' || echo 9999)
  near="${DEEPSEC_ERROR_NEAR_ZERO:-25}"
  if [[ "$errs" -le "$near" ]] \
    && tail -5 /tmp/deepsec-grok-finish.log 2>/dev/null | grep -q 'FINISH COMPLETE' \
    && ! tail -30 /tmp/deepsec-grok-finish.log 2>/dev/null | grep -q 'SKIP docs export'; then
    echo "=== supervisor done errors=$errs $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi
  echo "=== supervisor sleep ${INTERVAL}s $(date -u +%H:%M:%SZ) ==="
  sleep "$INTERVAL"
done
