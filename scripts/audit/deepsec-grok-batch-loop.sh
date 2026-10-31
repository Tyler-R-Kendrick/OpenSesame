#!/usr/bin/env bash
# Grok Build subscription only: process pending deepsec files in batches with preflight each batch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
PROJECT_ID=opensesame
LOG="${DEEPSEC_GROK_BATCH_LOG:-/tmp/deepsec-grok-batch-loop.log}"
BATCH_LIMIT="${DEEPSEC_BATCH_LIMIT:-10}"
AGENT="${DEEPSEC_AGENT:-grok}"
MODEL="${DEEPSEC_GROK_MODEL:-grok-4.7}"
CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"
unset DEEPSEC_MAX_BATCHES
MAX_BATCHES="${DEEPSEC_MAX_BATCHES:-0}"

exec >>"$LOG" 2>&1

pending_count() {
  (cd "$WS" && "$DEEPSEC" status --project-id "$PROJECT_ID" 2>/dev/null) \
    | sed 's/\x1b\[[0-9;]*m//g' \
    | awk '/pending:/ { gsub(/[^0-9]/,"",$2); print $2; exit }'
}

quota_limited() {
  ! "${ROOT}/scripts/audit/deepsec-grok-quota-probe.sh"
}

echo "=== batch loop start $(date -u +%Y-%m-%dT%H:%M:%SZ) limit=$BATCH_LIMIT agent=$AGENT model=$MODEL ==="

if [[ "$AGENT" != "grok" ]]; then
  echo "batch loop: DEEPSEC_AGENT must be grok (subscription billing)" >&2
  exit 1
fi

batch=0
while true; do
  pending="$(pending_count)"
  pending="${pending:-0}"
  if [[ "$pending" -eq 0 ]]; then
    echo "=== batch loop complete: no pending files $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi
  if [[ "$MAX_BATCHES" -gt 0 && "$batch" -ge "$MAX_BATCHES" ]]; then
    echo "=== batch loop stopped: MAX_BATCHES=$MAX_BATCHES pending=$pending $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi

  if ! bash "${ROOT}/scripts/audit/deepsec-grok-subscription-verify.sh"; then
    echo "=== batch loop stop: subscription verify failed $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 2
  fi
  if quota_limited; then
    echo "=== batch loop stop: Grok subscription quota/limit $(date -u +%Y-%m-%dT%H:%M:%SZ) pending=$pending batch=$batch ==="
    exit 42
  fi

  batch=$((batch + 1))
  echo "=== batch $batch pending=$pending $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  set +e
  (
    cd "$WS"
    unset XAI_API_KEY GROK_CODE_XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY
    "$DEEPSEC" process --project-id "$PROJECT_ID" \
      --agent "$AGENT" \
      --model "$MODEL" \
      --thinking-level "${DEEPSEC_THINKING:-high}" \
      --concurrency "$CONCURRENCY" \
      --limit "$BATCH_LIMIT"
  )
  ec=$?
  set -e
  echo "=== batch $batch exit=$ec $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  if quota_limited; then
    echo "=== batch loop stop: quota after batch $batch pending=$(pending_count) ==="
    exit 42
  fi
  if [[ "$ec" -ne 0 ]]; then
    if tail -n 40 "$LOG" | grep -qiE 'usage limit|weekly limit|quota|429|403 credits'; then
      echo "=== batch loop stop: quota pattern in log ==="
      exit 42
    fi
    echo "WARN: batch $batch process exited $ec — continuing with next batch"
  fi
  node "${ROOT}/scripts/audit/deepsec-wave2-reconcile-file-locks.mjs" "$ROOT" 2>/dev/null || true
done
