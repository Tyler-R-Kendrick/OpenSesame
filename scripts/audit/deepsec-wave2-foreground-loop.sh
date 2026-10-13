#!/usr/bin/env bash
# Foreground wave-2 babysitter: 15m ticks, 30m hang restart, finish at 1986/1986.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RELOG="${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
LOG=/tmp/deepsec-wave2-foreground-loop.log
STATE=/tmp/deepsec-wave2-foreground.state
TICK_SEC="${DEEPSEC_FOREGROUND_TICK_SEC:-900}"
HANG_SEC="${DEEPSEC_WAVE2_HANG_SEC:-1800}"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

exec >>"$LOG" 2>&1
echo "=== foreground loop start $(date -u +%Y-%m-%dT%H:%M:%SZ) tick=${TICK_SEC}s hang=${HANG_SEC}s ==="

ensure_watchers() {
  for script in deepsec-wave2-kimi-watch.sh deepsec-kimi-quota-watch.sh deepsec-kimi-supervisor.sh deepsec-wave2-watch.sh; do
    if ! pgrep -f "$script" >/dev/null; then
      nohup "${ROOT}/scripts/audit/$script" >>"/tmp/${script%.sh}.nohup" 2>&1 &
      echo "started $script"
    fi
  done
}

run_start_line() {
  if [[ ! -f "$RELOG" ]]; then
    echo 0
    return
  fi
  grep -n '^=== reinvestigate wave 2 start ' "$RELOG" | tail -1 | cut -d: -f1 || echo 0
}

batch_complete_since_run() {
  local start_line="$1"
  if [[ ! -f "$RELOG" ]] || [[ "$start_line" -le 0 ]]; then
    echo 0
    return
  fi
  tail -n +"$start_line" "$RELOG" | grep -cE 'Batch [0-9]+/[0-9]+ complete:' || true
}

last_batch_epoch_since_run() {
  local start_line="$1"
  if [[ ! -f "$RELOG" ]] || [[ "$start_line" -le 0 ]]; then
    echo 0
    return
  fi
  local mtime
  mtime="$(stat -c %Y "$RELOG" 2>/dev/null || echo 0)"
  if tail -n +"$start_line" "$RELOG" | grep -qE 'Batch [0-9]+/[0-9]+ complete:'; then
    echo "$mtime"
  else
    echo 0
  fi
}

kimi_running() {
  pgrep -f 'deepsec/dist/cli.mjs process.*--agent kimi' >/dev/null \
    || pgrep -f 'deepsec-grok-reinvestigate-wave.sh' >/dev/null
}

# shellcheck disable=SC1090
[[ -f "$STATE" ]] && source "$STATE" || true
last_batch_count="${last_batch_count:-0}"
last_batch_epoch="${last_batch_epoch:-0}"

while true; do
  ensure_watchers
  progress="$(node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 2>/dev/null || true)"
  remaining="$(node "${ROOT}/scripts/audit/deepsec-wave2-remaining.mjs" "$ROOT" 2 2>/dev/null || true)"
  complete="$(node -e "try{console.log(JSON.parse(process.argv[1]).filesComplete)}catch{console.log(0)}" "$progress")"
  tracked="$(node -e "try{console.log(JSON.parse(process.argv[1]).filesTracked)}catch{console.log(1986)}" "$progress")"
  now_epoch="$(date +%s)"
  start_line="$(run_start_line)"
  batch_count="$(batch_complete_since_run "$start_line" | tr -dc '0-9')"
  batch_count="${batch_count:-0}"

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) complete=$complete/$tracked batches_this_run=$batch_count $remaining"

  if [[ "$complete" -ge "$tracked" ]] && [[ "$tracked" -gt 0 ]]; then
    echo "=== wave2 gate satisfied — running finish $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    if "${ROOT}/scripts/audit/deepsec-grok-finish.sh"; then
      echo "=== FINISH COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      exit 0
    fi
    echo "=== finish failed exit $? $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 3
  fi

  if "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
    if [[ "$batch_count" != "$last_batch_count" ]]; then
      last_batch_count="$batch_count"
      last_batch_epoch="$now_epoch"
    elif [[ "$last_batch_epoch" -eq 0 ]] && [[ "$batch_count" -gt 0 ]]; then
      last_batch_epoch="$(last_batch_epoch_since_run "$start_line")"
      [[ "$last_batch_epoch" -eq 0 ]] && last_batch_epoch="$now_epoch"
    fi

    if kimi_running; then
      if [[ "$last_batch_epoch" -gt 0 ]]; then
        idle=$((now_epoch - last_batch_epoch))
        if [[ "$idle" -ge "$HANG_SEC" ]]; then
          echo "=== HANG idle=${idle}s — restart $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
          "${ROOT}/scripts/audit/deepsec-wave2-restart-kimi.sh" || true
          last_batch_count=0
          last_batch_epoch="$now_epoch"
        fi
      fi
    else
      echo "=== no kimi process — start reinvestigate $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      "${ROOT}/scripts/audit/deepsec-wave2-restart-kimi.sh" || true
      last_batch_count=0
      last_batch_epoch="$now_epoch"
    fi
  else
    echo "=== quota limited — stop kimi $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    pkill -9 -f 'deepsec/dist/cli.mjs process.*--agent kimi' 2>/dev/null || true
    pkill -9 -f 'deepsec-grok-reinvestigate-wave.sh' 2>/dev/null || true
    last_batch_epoch=0
  fi

  {
    echo "last_batch_count=$last_batch_count"
    echo "last_batch_epoch=$last_batch_epoch"
  } >"$STATE"

  sleep "$TICK_SEC"
done
