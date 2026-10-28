#!/usr/bin/env bash
# Kimi K3 wave-2 reinvestigate on marker-incomplete files while Grok runs (subscription only).
# One file per deepsec process so a single slow file cannot hold a batch-of-3 (~2.5–3h) before
# any strict completion lands; per-file wall matches Grok ordered lane (DEEPSEC_KIMI_FILE_WALL_SEC).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
LOG="${DEEPSEC_KIMI_PARALLEL_LOG:-/tmp/deepsec-wave2-kimi-parallel.log}"
export PATH="${HOME}/.local/bin:${PATH}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_KIMI_PARALLEL_CONCURRENCY:-1}"
export DEEPSEC_BATCH_SIZE="${DEEPSEC_KIMI_PARALLEL_BATCH_SIZE:-1}"
export DEEPSEC_KIMI_FILE_WALL_SEC="${DEEPSEC_KIMI_FILE_WALL_SEC:-2700}"
export DEEPSEC_KIMI_USE_COREUTILS_TIMEOUT="${DEEPSEC_KIMI_USE_COREUTILS_TIMEOUT:-1}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

exec >>"$LOG" 2>&1
echo "=== kimi-parallel start $(date -u +%Y-%m-%dT%H:%M:%SZ) wave=$WAVE concurrency=$DEEPSEC_CONCURRENCY batch_size=$DEEPSEC_BATCH_SIZE file_wall_sec=$DEEPSEC_KIMI_FILE_WALL_SEC ordered_slices=1 ==="

if ! "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
  echo "=== kimi-parallel: quota limited — sleeping (probe every ${DEEPSEC_KIMI_PARALLEL_QUOTA_SLEEP_SEC:-300}s) $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  while ! "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; do
    sleep "${DEEPSEC_KIMI_PARALLEL_QUOTA_SLEEP_SEC:-300}"
  done
  echo "=== kimi-parallel: quota clear — resuming $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
fi

MANIFEST="$(mktemp /tmp/deepsec-wave2-marker-incomplete.XXXXXX.json)"
node "${ROOT}/scripts/audit/deepsec-wave2-marker-incomplete-manifest.mjs" "$ROOT" "$WAVE" >"$MANIFEST"
TOTAL="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$MANIFEST")"
echo "=== kimi-parallel manifest $TOTAL files ==="
if [[ "$TOTAL" == "0" ]]; then
  rm -f "$MANIFEST"
  echo "=== kimi-parallel: nothing pending — exit $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  exit 0
fi

SLICE="$(mktemp /tmp/deepsec-wave2-kimi-slice.XXXXXX.json)"
idx=0
while [[ "$idx" -lt "$TOTAL" ]]; do
  node -e "
    const paths = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const i = Number(process.argv[2]);
    const batch = Number(process.argv[3]);
    const slice = paths.slice(i, i + batch);
    require('fs').writeFileSync(process.argv[4], JSON.stringify(slice));
  " "$MANIFEST" "$idx" "$DEEPSEC_BATCH_SIZE" "$SLICE"
  slice_count="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$SLICE")"
  if [[ "$slice_count" == "0" ]]; then
    idx=$((idx + 1))
    continue
  fi
  path="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[0])" "$SLICE")"
  echo "deepsec-wave2-kimi-parallel: file $((idx + 1))/${TOTAL} ${path} (slice ${slice_count} path(s))"
  cd "$WS"
  set +e
  if [[ "$DEEPSEC_KIMI_USE_COREUTILS_TIMEOUT" == "1" ]] && command -v timeout >/dev/null; then
    timeout --foreground "${DEEPSEC_KIMI_FILE_WALL_SEC}" \
      "$DEEPSEC" process --project-id opensesame \
      --agent kimi --model kimi-code/k3 \
      --thinking-level "$DEEPSEC_THINKING" \
      --concurrency "$DEEPSEC_CONCURRENCY" \
      --reinvestigate "$WAVE" \
      --batch-size "$DEEPSEC_BATCH_SIZE" \
      --manifest "$SLICE"
  else
    "$DEEPSEC" process --project-id opensesame \
      --agent kimi --model kimi-code/k3 \
      --thinking-level "$DEEPSEC_THINKING" \
      --concurrency "$DEEPSEC_CONCURRENCY" \
      --reinvestigate "$WAVE" \
      --batch-size "$DEEPSEC_BATCH_SIZE" \
      --manifest "$SLICE"
  fi
  deepsec_rc=$?
  set -e
  if [[ "$deepsec_rc" -ne 0 ]]; then
    reason="process_exit"
    if tail -30 "$LOG" 2>/dev/null | grep -qE 'file wall exceeded|timed out|Termin'; then
      reason="file_wall_exceeded"
    fi
    node "${ROOT}/scripts/audit/deepsec-wave2-kimi-deferred.mjs" path "$ROOT" "$path" "$reason"
    echo "deepsec-wave2-kimi-parallel: deferred ${path} (${reason}) — continuing"
  fi
  idx=$((idx + DEEPSEC_BATCH_SIZE))
done
rm -f "$SLICE" "$MANIFEST"
echo "=== kimi-parallel done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
