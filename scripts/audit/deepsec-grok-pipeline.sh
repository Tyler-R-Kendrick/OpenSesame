#!/usr/bin/env bash
set -euo pipefail
LOG=/tmp/deepsec-grok-pipeline.log
ROOT=/workspace
WS=/workspace/.deepsec
DEEPSEC="$WS/node_modules/.bin/deepsec"
MODEL=grok-4.7
export DEEPSEC_THINKING=high
export DEEPSEC_CONCURRENCY=2

exec > >(tee -a "$LOG") 2>&1

echo "=== deepsec grok pipeline start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
unset XAI_API_KEY GROK_DEPLOYMENT_KEY

run_process() {
  local label="$1"
  local filter="$2"
  echo "=== PROCESS $label filter=$filter $(date -u +%H:%M:%S) ==="
  cd "$WS"
  "$DEEPSEC" process --project-id opensesame \
    --agent grok --model "$MODEL" \
    --thinking-level "$DEEPSEC_THINKING" \
    --concurrency "$DEEPSEC_CONCURRENCY" \
    --filter "$filter" || echo "WARN: process $label exited $?"
}

run_process core-app-core "packages/app-core/"
run_process core-vault-core "packages/vault-core/"
run_process core-host-core "crates/host-core/"
run_process core-client-core "crates/client-core/"
run_process core-core "crates/core/"
run_process pwa "apps/pages/"
run_process cli-native "apps/cli/"
run_process cli-ts "packages/cli/"

echo "=== REVALIDATE $(date -u +%H:%M:%S) ==="
cd "$WS"
"$DEEPSEC" revalidate --project-id opensesame \
  --agent grok --model "$MODEL" \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" || echo "WARN: revalidate exited $?"

echo "=== TRIAGE --agent grok --model $MODEL $(date -u +%H:%M:%S) ==="
cd "$ROOT"
node scripts/audit/deepsec-grok-triage.mjs --all-severities || echo "WARN: triage exited $?"

OUT="$WS/findings-grok"
echo "=== EXPORT -> $OUT $(date -u +%H:%M:%S) ==="
"$DEEPSEC" export --project-id opensesame --format md-dir --out "$OUT" || echo "WARN: export exited $?"

echo "=== PIPELINE COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
