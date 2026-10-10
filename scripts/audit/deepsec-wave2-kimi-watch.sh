#!/usr/bin/env bash
# Kimi-only wave-2 monitor: restart workers after VM sleep, resume K3 after quota reset,
# detect hung reinvestigate (no batch complete for 30m while quota clear).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG=/tmp/deepsec-wave2-kimi-watch.log
RELOG="${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
INTERVAL="${DEEPSEC_KIMI_WATCH_INTERVAL_SEC:-1200}"
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
    || pgrep -f 'deepsec-grok-reinvestigate-wave.sh' >/dev/null
}

batch_complete_count() {
  if [[ ! -f "$RELOG" ]]; then
    echo 0
    return
  fi
  grep -cE 'Batch [0-9]+/[0-9]+ complete:' "$RELOG" 2>/dev/null || echo 0
}

last_complete=-1
stall_count=0
kimi_was_limited=1
last_batch_count=-1
last_batch_epoch=0

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

  if "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
    if [[ "$kimi_was_limited" -eq 1 ]]; then
      echo "=== kimi quota clear $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting wave2 on K3 ==="
      kimi_was_limited=0
      stall_count=0
      last_complete=-1
      last_batch_epoch="$now_epoch"
    fi

    if reinvestigate_running; then
      if [[ "$last_batch_epoch" -gt 0 ]]; then
        idle=$((now_epoch - last_batch_epoch))
        if [[ "$idle" -ge "$HANG_SEC" ]]; then
          echo "=== HANG detected idle=${idle}s (>=${HANG_SEC}s) — restart reinvestigate $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
          "${ROOT}/scripts/audit/deepsec-wave2-restart-kimi.sh" || true
          last_batch_epoch="$now_epoch"
          stall_count=0
        fi
      fi
    elif ! node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 >/dev/null; then
      nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
      echo "started reinvestigate-wave (kimi)"
      last_batch_epoch="$now_epoch"
    fi
  else
    kimi_was_limited=1
    if pgrep -f 'deepsec/dist/cli.mjs process.*--agent kimi' >/dev/null; then
      pkill -f 'deepsec/dist/cli.mjs process.*--agent kimi' || true
      echo "stopped kimi deepsec (quota)"
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
