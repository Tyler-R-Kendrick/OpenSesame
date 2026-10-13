#!/usr/bin/env bash
# Resume deepsec AI investigation after quota or batch failures (no full rescan).
# Processes pending files, then retries status=error paths from the error manifest.
#
# Throughput (Kimi K3 subscription, batch-size 5):
#   ~7 min per batch is expected (one agent call per batch, medium thinking).
#   Keep DEEPSEC_CONCURRENCY=1 while the 5-hour quota is tight; after quota resets,
#   rerun with DEEPSEC_CONCURRENCY=2 (same script) to overlap batches — finish.sh
#   already defaults to concurrency 2 for error rerun / revalidate.
#   Optional: DEEPSEC_BATCH_SIZE=5 (default) — raising batch size saves CLI overhead
#   but increases timeout risk per batch.
# Skipping generated / test-only sources is not enabled for this repo scan: every
# tracked file already has regex candidates from `deepsec scan`. Use
#   deepsec process --skip-slugs <csv>
# only when a file's candidates are exclusively low-value matcher slugs (see
# `deepsec process --help`). Direct-mode `--no-ignore` bypasses test/dist filters;
# we do not use direct mode for the full opensesame project.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
PROJECT_ID=opensesame
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${DEEPSEC_AGENT:-kimi}"
MODEL="${DEEPSEC_GROK_MODEL:-kimi-code/k3}"
LOG="${DEEPSEC_RESUME_LOG:-/tmp/deepsec-kimi-resume.log}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-1}"

exec > >(tee -a "$LOG") 2>&1

echo "=== deepsec kimi resume $(date -u +%Y-%m-%dT%H:%M:%SZ) agent=$AGENT model=$MODEL concurrency=$DEEPSEC_CONCURRENCY ==="
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

quota_hit() {
  tail -n 30 "$LOG" | grep -qiE '5-hour usage limit|provider\.auth_error:\s*403'
}

run_process() {
  local label="$1"
  shift
  echo "=== PROCESS $label $(date -u +%H:%M:%S) ==="
  cd "$WS"
  if ! "$DEEPSEC" process --project-id "$PROJECT_ID" \
    --agent "$AGENT" --model "$MODEL" \
    --thinking-level "$DEEPSEC_THINKING" \
    --concurrency "$DEEPSEC_CONCURRENCY" \
    "$@"; then
    echo "WARN: process $label exited $?"
    if quota_hit; then
      echo "STOP: Kimi 5-hour quota hit — check https://www.kimi.com/membership/subscription?tab=quota"
      exit 2
    fi
  fi
}

echo "=== STATUS BEFORE $(date -u +%H:%M:%S) ==="
"$DEEPSEC" status --project-id "$PROJECT_ID" || true

echo "=== PENDING FILES $(date -u +%H:%M:%S) ==="
run_process pending

MANIFEST="$(mktemp /tmp/deepsec-error-manifest.XXXXXX.json)"
node "${ROOT}/scripts/audit/deepsec-grok-error-manifest.mjs" "$ROOT" >"$MANIFEST"
COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).length)")"
echo "=== ERROR MANIFEST ($COUNT files) $(date -u +%H:%M:%S) ==="
if [[ "$COUNT" -gt 0 ]]; then
  run_process errors --manifest "$MANIFEST"
fi
rm -f "$MANIFEST"

echo "=== STATUS AFTER $(date -u +%H:%M:%S) ==="
"$DEEPSEC" status --project-id "$PROJECT_ID" || true
echo "=== RESUME PASS COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
