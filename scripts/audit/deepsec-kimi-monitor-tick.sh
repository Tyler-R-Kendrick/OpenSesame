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
if ! "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh" >>"$LOG" 2>&1; then
  echo "kimi: quota limited" >>"$LOG"
  if pgrep -f 'deepsec/dist/cli.mjs process.*--agent kimi' >/dev/null; then
    pkill -f 'deepsec/dist/cli.mjs process.*--agent kimi' || true
    echo "stopped kimi deepsec process (quota)" >>"$LOG"
  fi
  if "${ROOT}/scripts/audit/deepsec-cursor-auth-probe.sh" >>"$LOG" 2>&1; then
    echo "cursor: composer available — starting wave2" >>"$LOG"
    if ! pgrep -f 'deepsec-grok-reinvestigate-wave.sh' >/dev/null \
      && ! pgrep -f 'deepsec/dist/cli.mjs process' >/dev/null; then
      nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
    fi
  fi
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
  | sed 's/.*error:[[:space:]]*//' | tr -dc '0-9' || true)
errs="${errs:-0}"
if [[ -z "$errs" ]]; then errs=0; fi
if [[ "$errs" -le 25 ]] && ! pgrep -f deepsec-kimi-error-loop.sh >/dev/null; then
  if node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 >/dev/null \
    && { ! grep -q 'FINISH COMPLETE' /tmp/deepsec-grok-finish.log 2>/dev/null \
      || tail -5 /tmp/deepsec-grok-finish.log | grep -q 'SKIP docs export'; }; then
    echo "errors=$errs — running finish $(date -u +%H:%M:%SZ)" >>"$LOG"
    DEEPSEC_CONCURRENCY=2 DEEPSEC_THINKING=high "${ROOT}/scripts/audit/deepsec-grok-finish.sh" >>/tmp/deepsec-grok-finish.nohup 2>&1 &
  fi
fi
if ! pgrep -f deepsec-grok-reinvestigate-wave.sh >/dev/null \
  && ! pgrep -f 'deepsec/dist/cli.mjs process' >/dev/null \
  && ! node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 >/dev/null; then
  if "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh" \
    || "${ROOT}/scripts/audit/deepsec-cursor-auth-probe.sh"; then
    echo "wave2 incomplete — starting reinvestigate $(date -u +%H:%M:%SZ)" >>"$LOG"
    nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
  else
    echo "wave2 incomplete — no agent available (sleeping)" >>"$LOG"
  fi
fi
