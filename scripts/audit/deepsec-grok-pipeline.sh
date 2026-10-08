#!/usr/bin/env bash
set -euo pipefail
LOG=/tmp/deepsec-grok-pipeline.log
ROOT=/workspace
WS=/workspace/.deepsec
DEEPSEC="$WS/node_modules/.bin/deepsec"
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${DEEPSEC_AGENT:-kimi}"
MODEL="${DEEPSEC_GROK_MODEL:-kimi-code/k3}"
export DEEPSEC_THINKING=high
export DEEPSEC_CONCURRENCY=2

exec > >(tee -a "$LOG") 2>&1

echo "=== deepsec pipeline start $(date -u +%Y-%m-%dT%H:%M:%SZ) agent=$AGENT model=$MODEL ==="
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

run_process() {
  local label="$1"
  local filter="$2"
  echo "=== PROCESS $label filter=$filter $(date -u +%H:%M:%S) ==="
  cd "$WS"
  "$DEEPSEC" process --project-id opensesame \
    --agent "$AGENT" --model "$MODEL" \
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
  --agent "$AGENT" --model "$MODEL" \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" || echo "WARN: revalidate exited $?"

echo "=== TRIAGE --agent $AGENT --model $MODEL $(date -u +%H:%M:%S) ==="
cd "$ROOT"
export DEEPSEC_AGENT="$AGENT"
export DEEPSEC_GROK_MODEL="$MODEL"
node scripts/audit/deepsec-grok-triage.mjs --all-severities || echo "WARN: triage exited $?"

OUT="$WS/findings-grok"
echo "=== EXPORT -> $OUT $(date -u +%H:%M:%S) ==="
"$DEEPSEC" export --project-id opensesame --format md-dir --out "$OUT" || echo "WARN: export exited $?"

echo "=== DOCS EXPORT $(date -u +%H:%M:%S) ==="
node scripts/audit/deepsec-export-docs.mjs "$ROOT" || echo "WARN: docs export exited $?"

echo "=== PIPELINE COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
