#!/usr/bin/env bash
# 30-minute Grok concurrency trial (subscription CLI). Keeps higher concurrency only if throughput rises without 429s.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DURATION_SEC="${DEEPSEC_CONCURRENCY_TRIAL_SEC:-1800}"
BASE_C="${DEEPSEC_CONCURRENCY_BASE:-4}"
TRIAL_C="${DEEPSEC_CONCURRENCY_TRIAL:-6}"
LOG="${DEEPSEC_CONCURRENCY_TRIAL_LOG:-/tmp/deepsec-wave2-concurrency-trial.log}"
RELOG="${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

exec >>"$LOG" 2>&1
echo "=== concurrency trial start $(date -u +%Y-%m-%dT%H:%M:%SZ) base=${BASE_C} trial=${TRIAL_C} duration=${DURATION_SEC}s ==="

PRE_REPORT="$(node "${ROOT}/scripts/audit/deepsec-wave2-throughput-snapshot.mjs" report "$ROOT" 2>/dev/null || echo '{}')"
PRE_RATE="$(node -e "try{console.log(JSON.parse(process.argv[1]).filesPerHour??0)}catch{console.log(0)}" "$PRE_REPORT")"
echo "pre_trial_rate=${PRE_RATE} ${PRE_REPORT}"

node "${ROOT}/scripts/audit/deepsec-wave2-throughput-snapshot.mjs" baseline "$ROOT"
MARK_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "trial_relog_mark=${MARK_START}" >>"$LOG"

DEEPSEC_CONCURRENCY="$TRIAL_C" "${ROOT}/scripts/audit/deepsec-wave2-restart.sh"
sleep "$DURATION_SEC"

FAILS=0
if [[ -f "$RELOG" ]]; then
  TRIAL_START_LINE="$(grep -n '^=== reinvestigate wave 2 start ' "$RELOG" | tail -1 | cut -d: -f1 || echo 0)"
  if [[ "$TRIAL_START_LINE" -gt 0 ]]; then
    FAILS="$(tail -n +"$TRIAL_START_LINE" "$RELOG" | grep -ciE '429|rate.?limit exceeded|too many requests' || true)"
  fi
fi
FAILS="${FAILS:-0}"

REPORT="$(node "${ROOT}/scripts/audit/deepsec-wave2-throughput-snapshot.mjs" report "$ROOT" 2>/dev/null || echo '{}')"
RATE="$(node -e "try{console.log(JSON.parse(process.argv[1]).filesPerHour??0)}catch{console.log(0)}" "$REPORT")"
DELTA="$(node -e "try{console.log(JSON.parse(process.argv[1]).deltaFiles??0)}catch{console.log(0)}" "$REPORT")"

KEEP=0
if [[ "$FAILS" -eq 0 ]] && [[ "$DELTA" -gt 0 ]]; then
  if awk -v r="$RATE" -v p="$PRE_RATE" 'BEGIN { exit (r > p * 0.98) ? 0 : 1 }'; then
    KEEP=1
  fi
fi

echo "=== concurrency trial result $(date -u +%Y-%m-%dT%H:%M:%SZ) keep_trial=${KEEP} trial_filesPerHour=${RATE} pre_filesPerHour=${PRE_RATE} delta=${DELTA} grok_429_since_mark=${FAILS} ==="
echo "$REPORT"

if [[ "$KEEP" -eq 1 ]]; then
  echo "DEEPSEC_CONCURRENCY=${TRIAL_C}" > /tmp/deepsec-wave2-concurrency-choice.env
  echo "keeping concurrency ${TRIAL_C}"
else
  echo "DEEPSEC_CONCURRENCY=${BASE_C}" > /tmp/deepsec-wave2-concurrency-choice.env
  DEEPSEC_CONCURRENCY="$BASE_C" "${ROOT}/scripts/audit/deepsec-wave2-restart.sh"
  echo "reverted concurrency to ${BASE_C}"
fi
