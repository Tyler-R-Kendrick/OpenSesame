#!/usr/bin/env bash
# After process completes: rerun error files once, revalidate (grok), triage (grok), export.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
PROJECT_ID=opensesame
MODEL="${DEEPSEC_GROK_MODEL:-grok-4.7}"
LOG=/tmp/deepsec-grok-finish.log
exec > >(tee -a "$LOG") 2>&1

echo "=== deepsec grok finish start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
unset XAI_API_KEY GROK_DEPLOYMENT_KEY
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-high}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"

MANIFEST="$(mktemp /tmp/deepsec-error-manifest.XXXXXX.json)"
node "${ROOT}/scripts/audit/deepsec-grok-error-manifest.mjs" "$ROOT" >"$MANIFEST"
COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).length)")"
echo "=== RERUN ERROR FILES ($COUNT) $(date -u +%H:%M:%S) ==="
if [[ "$COUNT" -gt 0 ]]; then
  cd "$WS"
  "$DEEPSEC" process --project-id "$PROJECT_ID" \
    --agent grok --model "$MODEL" \
    --thinking-level "$DEEPSEC_THINKING" \
    --concurrency "$DEEPSEC_CONCURRENCY" \
    --manifest "$MANIFEST" || echo "WARN: error rerun exited $?"
fi
rm -f "$MANIFEST"

echo "=== REVALIDATE $(date -u +%H:%M:%S) ==="
cd "$WS"
"$DEEPSEC" revalidate --project-id "$PROJECT_ID" \
  --agent grok --model "$MODEL" \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" || echo "WARN: revalidate exited $?"

echo "=== TRIAGE --agent grok --model $MODEL $(date -u +%H:%M:%S) ==="
node "${ROOT}/scripts/audit/deepsec-grok-triage.mjs" --all-severities || echo "WARN: triage exited $?"

OUT="${WS}/findings-grok"
echo "=== EXPORT -> $OUT $(date -u +%H:%M:%S) ==="
"$DEEPSEC" export --project-id "$PROJECT_ID" --format md-dir --out "$OUT" || echo "WARN: export exited $?"

echo "=== FINISH COMPLETE $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
