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
if ! read -r tick_agent _ < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh" 2>>"$LOG"); then
  echo "wave2: no agent (grok/kimi/cursor unavailable)" >>"$LOG"
  if pgrep -f 'deepsec/dist/cli.mjs process' >/dev/null; then
    pkill -f 'deepsec/dist/cli.mjs process' || true
    echo "stopped deepsec process (no agent)" >>"$LOG"
  fi
elif [[ "$tick_agent" == "kimi" ]]; then
  echo "kimi: ok" >>"$LOG"
  errs=$(cd "$WS" && "$DEEPSEC" status --project-id opensesame 2>/dev/null \
    | grep -E '^[[:space:]]+error:' | head -1 \
    | sed 's/.*error:[[:space:]]*//' | tr -dc '0-9' || echo 9999)
  if [[ "$errs" -gt 25 ]] && ! pgrep -f deepsec-kimi-error-loop.sh >/dev/null; then
    export DEEPSEC_CONCURRENCY=2 DEEPSEC_THINKING=medium
    nohup "${ROOT}/scripts/audit/deepsec-kimi-error-loop.sh" >>/tmp/deepsec-kimi-error-loop.nohup 2>&1 &
    echo "started error-loop errors=$errs" >>"$LOG"
  fi
else
  echo "${tick_agent}: ok (wave2 primary)" >>"$LOG"
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
  if read -r _ _ < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh" 2>/dev/null); then
    echo "wave2 incomplete — starting reinvestigate $(date -u +%H:%M:%SZ)" >>"$LOG"
    nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
  else
    echo "wave2 incomplete — no agent available (sleeping)" >>"$LOG"
  fi
fi
