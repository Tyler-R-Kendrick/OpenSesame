#!/usr/bin/env bash
# After process completes: rerun error files once, revalidate (grok), triage (grok), export.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
PROJECT_ID=opensesame
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${DEEPSEC_AGENT:-kimi}"
MODEL="${DEEPSEC_GROK_MODEL:-kimi-code/k3}"
LOG=/tmp/deepsec-grok-finish.log
exec > >(tee -a "$LOG") 2>&1

echo "=== deepsec finish start $(date -u +%Y-%m-%dT%H:%M:%SZ) agent=$AGENT model=$MODEL ==="
if ! node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2; then
  echo "SKIP finish: investigate wave 2 not complete (see deepsec-wave2-progress.mjs)"
  exit 2
fi
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-high}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"

MANIFEST="$(mktemp /tmp/deepsec-error-manifest.XXXXXX.json)"
node "${ROOT}/scripts/audit/deepsec-grok-error-manifest.mjs" "$ROOT" >"$MANIFEST"
COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).length)")"
echo "=== RERUN ERROR FILES ($COUNT) $(date -u +%H:%M:%S) ==="
if [[ "$COUNT" -gt 0 ]]; then
  cd "$WS"
  "$DEEPSEC" process --project-id "$PROJECT_ID" \
    --agent "$AGENT" --model "$MODEL" \
    --thinking-level "$DEEPSEC_THINKING" \
    --concurrency "$DEEPSEC_CONCURRENCY" \
    --manifest "$MANIFEST" || echo "WARN: error rerun exited $?"
fi
rm -f "$MANIFEST"

echo "=== REVALIDATE $(date -u +%H:%M:%S) ==="
cd "$WS"
"$DEEPSEC" revalidate --project-id "$PROJECT_ID" \
  --agent "$AGENT" --model "$MODEL" \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" || echo "WARN: revalidate exited $?"

echo "=== TRIAGE --agent $AGENT --model $MODEL $(date -u +%H:%M:%S) ==="
export DEEPSEC_AGENT="$AGENT"
export DEEPSEC_GROK_MODEL="$MODEL"
node "${ROOT}/scripts/audit/deepsec-grok-triage.mjs" --all-severities || echo "WARN: triage exited $?"

OUT="${WS}/findings-grok"
echo "=== EXPORT -> $OUT $(date -u +%H:%M:%S) ==="
"$DEEPSEC" export --project-id "$PROJECT_ID" --format md-dir --out "$OUT" || echo "WARN: export exited $?"

GLOBAL_ERR="$(cd "$WS" && "$DEEPSEC" status --project-id "$PROJECT_ID" 2>/dev/null \
  | grep -E '^[[:space:]]+error:' | head -1 | sed 's/.*error:[[:space:]]*//' | tr -dc '0-9')"
GLOBAL_ERR="${GLOBAL_ERR:-0}"
NEAR_ZERO="${DEEPSEC_ERROR_NEAR_ZERO:-25}"
echo "=== global errors=$GLOBAL_ERR (near_zero=$NEAR_ZERO) $(date -u +%H:%M:%S) ==="
if [[ "$GLOBAL_ERR" -gt "$NEAR_ZERO" ]]; then
  echo "SKIP docs export: errors still above $NEAR_ZERO — re-run error-loop first"
  exit 1
fi

echo "=== DOCS EXPORT $(date -u +%H:%M:%S) ==="
node "${ROOT}/scripts/audit/deepsec-export-docs.mjs" "$ROOT" || echo "WARN: docs export exited $?"

echo "=== FINISH COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
