#!/usr/bin/env bash
# Long-run monitor: log progress, restart dead workers, run finish when wave 2 completes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG=/tmp/deepsec-wave2-watch.log
INTERVAL="${DEEPSEC_WATCH_INTERVAL_SEC:-1200}"

exec >>"$LOG" 2>&1
echo "=== wave2-watch start $(date -u +%Y-%m-%dT%H:%M:%SZ) interval=${INTERVAL}s ==="

ensure() {
  if ! pgrep -f deepsec-kimi-quota-watch.sh >/dev/null; then
    nohup "${ROOT}/scripts/audit/deepsec-kimi-quota-watch.sh" >>/tmp/deepsec-kimi-quota-watch.nohup 2>&1 &
    echo "restarted quota-watch"
  fi
  if ! pgrep -f deepsec-kimi-supervisor.sh >/dev/null; then
    nohup "${ROOT}/scripts/audit/deepsec-kimi-supervisor.sh" >>/tmp/deepsec-kimi-supervisor.nohup 2>&1 &
    echo "restarted supervisor"
  fi
  if ! pgrep -f 'deepsec-grok-reinvestigate-wave.sh' >/dev/null \
    && ! pgrep -f 'deepsec/dist/cli.mjs process.*reinvestigate 2' >/dev/null; then
    if ! node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 >/dev/null; then
      nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
      echo "restarted reinvestigate-wave"
    fi
  fi
}

while true; do
  ensure
  node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 || true
  if node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 >/dev/null; then
    echo "wave2 complete — triggering finish $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    DEEPSEC_CONCURRENCY=2 DEEPSEC_THINKING=high "${ROOT}/scripts/audit/deepsec-grok-finish.sh" || true
    if grep -q 'FINISH COMPLETE' /tmp/deepsec-grok-finish.log 2>/dev/null \
      && ! tail -5 /tmp/deepsec-grok-finish.log | grep -q 'SKIP docs export'; then
      echo "=== wave2-watch done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      exit 0
    fi
  fi
  sleep "$INTERVAL"
done
