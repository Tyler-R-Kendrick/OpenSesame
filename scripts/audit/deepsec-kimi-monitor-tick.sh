#!/usr/bin/env bash
# One 25-minute monitor tick: keep quota-watch alive, kick error-loop when quota is clear.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
LOG=/tmp/deepsec-kimi-monitor.log
echo "=== tick $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >>"$LOG"
if ! pgrep -f deepsec-kimi-quota-watch.sh >/dev/null; then
  nohup "${ROOT}/scripts/audit/deepsec-kimi-quota-watch.sh" >>/tmp/deepsec-kimi-quota-watch.nohup 2>&1 &
  echo "restarted quota-watch" >>"$LOG"
fi
(cd "$WS" && "$DEEPSEC" status --project-id opensesame) >>"$LOG" 2>&1 || true
if timeout 60 kimi -p 'reply ok' 2>&1 | grep -qiE '5-hour usage limit|403'; then
  echo "kimi: quota limited" >>"$LOG"
else
  echo "kimi: ok" >>"$LOG"
  errs=$(cd "$WS" && "$DEEPSEC" status --project-id opensesame 2>/dev/null \
    | grep -E '^[[:space:]]+error:' | head -1 \
    | sed 's/.*error:[[:space:]]*//' | tr -dc '0-9' || echo 9999)
  if [[ "$errs" -gt 25 ]] && ! pgrep -f deepsec-kimi-error-loop.sh >/dev/null; then
    export DEEPSEC_CONCURRENCY=2 DEEPSEC_THINKING=medium
    nohup "${ROOT}/scripts/audit/deepsec-kimi-error-loop.sh" >>/tmp/deepsec-kimi-error-loop.nohup 2>&1 &
    echo "started error-loop errors=$errs" >>"$LOG"
  fi
fi
errs=$(cd "$WS" && "$DEEPSEC" status --project-id opensesame 2>/dev/null \
  | grep -E '^[[:space:]]+error:' | head -1 \
  | sed 's/.*error:[[:space:]]*//' | tr -dc '0-9' || echo 9999)
if [[ "$errs" -le 25 ]] && ! pgrep -f deepsec-kimi-error-loop.sh >/dev/null; then
  if ! grep -q 'FINISH COMPLETE' /tmp/deepsec-grok-finish.log 2>/dev/null \
    || tail -5 /tmp/deepsec-grok-finish.log | grep -q 'SKIP docs export'; then
    echo "errors=$errs — running finish $(date -u +%H:%M:%SZ)" >>"$LOG"
    DEEPSEC_CONCURRENCY=2 DEEPSEC_THINKING=high "${ROOT}/scripts/audit/deepsec-grok-finish.sh" >>/tmp/deepsec-grok-finish.nohup 2>&1 &
  fi
fi
