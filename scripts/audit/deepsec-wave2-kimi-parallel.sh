#!/usr/bin/env bash
# Kimi K3 wave-2 reinvestigate on marker-incomplete files while Grok runs (subscription only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
LOG="${DEEPSEC_KIMI_PARALLEL_LOG:-/tmp/deepsec-wave2-kimi-parallel.log}"
export PATH="${HOME}/.local/bin:${PATH}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_KIMI_PARALLEL_CONCURRENCY:-1}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

exec >>"$LOG" 2>&1
echo "=== kimi-parallel start $(date -u +%Y-%m-%dT%H:%M:%SZ) wave=$WAVE concurrency=$DEEPSEC_CONCURRENCY ==="

if ! "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
  echo "=== kimi-parallel: quota limited — exit $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  exit 0
fi

MANIFEST="$(mktemp /tmp/deepsec-wave2-marker-incomplete.XXXXXX.json)"
node "${ROOT}/scripts/audit/deepsec-wave2-marker-incomplete-manifest.mjs" "$ROOT" "$WAVE" >"$MANIFEST"
COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$MANIFEST")"
echo "=== kimi-parallel manifest $COUNT files ==="
if [[ "$COUNT" == "0" ]]; then
  rm -f "$MANIFEST"
  echo "=== kimi-parallel: nothing pending — exit $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
  exit 0
fi

cd "$WS"
"$DEEPSEC" process --project-id opensesame \
  --agent kimi --model kimi-code/k3 \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" \
  --reinvestigate "$WAVE" \
  --batch-size "${DEEPSEC_BATCH_SIZE:-5}" \
  --manifest "$MANIFEST"
rm -f "$MANIFEST"
echo "=== kimi-parallel done $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
