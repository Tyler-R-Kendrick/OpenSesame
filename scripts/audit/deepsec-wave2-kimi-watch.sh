#!/usr/bin/env bash
# Kimi-only wave-2 monitor: restart workers after VM sleep, resume K3 after quota reset,
# detect hung reinvestigate (no batch complete for 30m while quota clear).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG=/tmp/deepsec-wave2-kimi-watch.log
RELOG="${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
INTERVAL="${DEEPSEC_KIMI_WATCH_INTERVAL_SEC:-900}"
STALL_TICKS="${DEEPSEC_STALL_TICKS:-3}"
HANG_SEC="${DEEPSEC_WAVE2_HANG_SEC:-1800}"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

exec >>"$LOG" 2>&1
echo "=== kimi-watch start $(date -u +%Y-%m-%dT%H:%M:%SZ) interval=${INTERVAL}s hang=${HANG_SEC}s ==="

ensure_workers() {
  if ! pgrep -f deepsec-kimi-quota-watch.sh >/dev/null; then
    nohup "${ROOT}/scripts/audit/deepsec-kimi-quota-watch.sh" >>/tmp/deepsec-kimi-quota-watch.nohup 2>&1 &
    echo "restarted quota-watch"
  fi
  if ! pgrep -f deepsec-kimi-supervisor.sh >/dev/null; then
    nohup "${ROOT}/scripts/audit/deepsec-kimi-supervisor.sh" >>/tmp/deepsec-kimi-supervisor.nohup 2>&1 &
    echo "restarted supervisor"
  fi
  if ! pgrep -f deepsec-wave2-watch.sh >/dev/null; then
    nohup "${ROOT}/scripts/audit/deepsec-wave2-watch.sh" >>/tmp/deepsec-wave2-watch.nohup 2>&1 &
    echo "restarted wave2-watch"
  fi
}

reinvestigate_running() {
  pgrep -f 'deepsec/dist/cli.mjs process.*--agent kimi' >/dev/null \
    || pgrep -f 'deepsec/dist/cli.mjs process.*--agent grok' >/dev/null \
    || pgrep -f 'deepsec/dist/cli.mjs process.*--agent cursor' >/dev/null \
    || pgrep -f 'deepsec-grok-reinvestigate-wave.sh' >/dev/null
}

reinvestigate_start_line() {
  if [[ ! -f "$RELOG" ]]; then
    echo 0
    return
  fi
  grep -n '^=== reinvestigate wave 2 start ' "$RELOG" | tail -1 | cut -d: -f1 || echo 0
}

batch_complete_count() {
  local start_line
  start_line="$(reinvestigate_start_line)"
  if [[ ! -f "$RELOG" ]] || [[ "$start_line" -le 0 ]]; then
    echo 0
    return
  fi
  tail -n +"$start_line" "$RELOG" | grep -cE 'Batch [0-9]+/[0-9]+ complete:' || true
}

last_complete=-1
stall_count=0
kimi_was_limited=1
last_batch_count=-1
last_batch_epoch=0
last_files_complete=-1
last_progress_epoch=0

while true; do
  ensure_workers
  progress="$(node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 2>/dev/null || true)"
  remaining="$(node "${ROOT}/scripts/audit/deepsec-wave2-remaining.mjs" "$ROOT" 2 2>/dev/null || true)"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $progress remaining=$remaining"

  if tail -30 /tmp/deepsec-grok-finish.log 2>/dev/null | grep -q 'FINISH COMPLETE' \
    && ! tail -30 /tmp/deepsec-grok-finish.log 2>/dev/null | grep -q 'SKIP docs export'; then
    echo "=== FINISH COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi

  batch_count="$(batch_complete_count | tr -dc '0-9')"
  batch_count="${batch_count:-0}"
  now_epoch="$(date +%s)"
  if [[ "$batch_count" != "$last_batch_count" ]]; then
    last_batch_count="$batch_count"
    last_batch_epoch="$now_epoch"
    echo "batch_complete_count=$batch_count epoch=$last_batch_epoch"
  elif [[ "$last_batch_epoch" -eq 0 ]] && [[ "$batch_count" -gt 0 ]]; then
    last_batch_epoch="$now_epoch"
  fi

  if read -r wave_agent _ < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh" 2>/dev/null); then
    if [[ "$kimi_was_limited" -eq 1 ]]; then
      echo "=== wave2 agent available ($wave_agent) $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      kimi_was_limited=0
      stall_count=0
      last_complete=-1
      last_batch_epoch="$now_epoch"
    fi

    complete_now="$(node -e "try{console.log(JSON.parse(process.argv[1]).filesComplete)}catch{console.log(-1)}" "$progress")"
    if [[ "$complete_now" =~ ^[0-9]+$ ]] && [[ "$complete_now" -ge 0 ]]; then
      if [[ "$last_files_complete" -lt 0 ]] || [[ "$complete_now" -gt "$last_files_complete" ]]; then
        last_files_complete="$complete_now"
        last_progress_epoch="$now_epoch"
      elif [[ "$last_progress_epoch" -eq 0 ]] && [[ "$complete_now" -gt 0 ]]; then
        last_progress_epoch="$now_epoch"
      fi
    fi

    if reinvestigate_running; then
      idle_batch=0
      idle_progress=0
      if [[ "$last_batch_epoch" -gt 0 ]]; then
        idle_batch=$((now_epoch - last_batch_epoch))
      fi
      if [[ "$last_progress_epoch" -gt 0 ]]; then
        idle_progress=$((now_epoch - last_progress_epoch))
      fi
      if [[ "$idle_batch" -ge "$HANG_SEC" ]] || [[ "$idle_progress" -ge "$HANG_SEC" ]]; then
        echo "=== HANG detected idle_batch=${idle_batch}s idle_progress=${idle_progress}s complete=${complete_now} — restart reinvestigate $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        "${ROOT}/scripts/audit/deepsec-wave2-restart.sh" || true
        last_batch_epoch="$now_epoch"
        last_progress_epoch="$now_epoch"
        stall_count=0
      fi
    elif ! node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 >/dev/null; then
      "${ROOT}/scripts/audit/deepsec-wave2-restart.sh" || true
      echo "started reinvestigate-wave ($wave_agent)"
      last_batch_epoch="$now_epoch"
    fi
  else
    kimi_was_limited=1
    if pgrep -f 'deepsec/dist/cli.mjs process.*(--reinvestigate|--agent (kimi|grok|cursor))' >/dev/null; then
      pkill -f 'deepsec/dist/cli.mjs process.*(--reinvestigate|--agent (kimi|grok|cursor))' || true
      echo "stopped deepsec process (no agent)"
    fi
  fi

  complete="$(node -e "try{console.log(JSON.parse(process.argv[1]).filesComplete)}catch{console.log(-1)}" "$progress")"
  if [[ "$complete" =~ ^[0-9]+$ ]] && [[ "$kimi_was_limited" -eq 0 ]]; then
    if [[ "$last_complete" -ge 0 ]] && [[ "$complete" -le "$last_complete" ]]; then
      stall_count=$((stall_count + 1))
      echo "stall tick $stall_count/$STALL_TICKS (complete=$complete)"
      if [[ "$stall_count" -ge "$STALL_TICKS" ]]; then
        echo "=== WAVE2 STALL after kimi reset complete=$complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        exit 2
      fi
    else
      stall_count=0
    fi
    last_complete="$complete"
  fi

  sleep "$INTERVAL"
done
