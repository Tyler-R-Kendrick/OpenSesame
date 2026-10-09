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
  if tail -3 /tmp/deepsec-grok-finish.log 2>/dev/null | grep -q 'FINISH COMPLETE' \
    && ! tail -20 /tmp/deepsec-grok-finish.log 2>/dev/null | grep -q 'SKIP docs export'; then
    echo "=== supervisor done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi
  echo "=== supervisor sleep ${INTERVAL}s $(date -u +%H:%M:%SZ) ==="
  sleep "$INTERVAL"
done
