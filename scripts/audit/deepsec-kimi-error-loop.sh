#!/usr/bin/env bash
# Retry error-manifest processing until global errors are near zero or quota stops.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
PROJECT_ID=opensesame
export PATH="${HOME}/.local/bin:${PATH}"
AGENT="${DEEPSEC_AGENT:-kimi}"
MODEL="${DEEPSEC_GROK_MODEL:-kimi-code/k3}"
LOG="${DEEPSEC_ERROR_LOOP_LOG:-/tmp/deepsec-kimi-error-loop.log}"
NEAR_ZERO="${DEEPSEC_ERROR_NEAR_ZERO:-25}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"

exec >>"$LOG" 2>&1
echo "=== error-loop start $(date -u +%Y-%m-%dT%H:%M:%SZ) near_zero=$NEAR_ZERO concurrency=$DEEPSEC_CONCURRENCY ==="
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

quota_hit() {
  tail -n 40 "$LOG" | grep -qiE '5-hour usage limit|provider\.auth_error:\s*403|kimi quota or rate limit'
}

error_count() {
  cd "$WS"
  "$DEEPSEC" status --project-id "$PROJECT_ID" 2>/dev/null \
    | grep -E '^[[:space:]]+error:' \
    | head -1 \
    | sed 's/.*error:[[:space:]]*//' \
    | tr -dc '0-9' || echo 9999
}

kimi_ok() {
  timeout 60 kimi -p 'reply ok' 2>&1 | grep -qiE '5-hour usage limit|provider\.auth_error:\s*403|kimi quota or rate limit' && return 1
  return 0
}

while true; do
  errs="$(error_count)"
  echo "=== loop tick $(date -u +%H:%M:%S) errors=$errs ==="
  if [[ "$errs" -le "$NEAR_ZERO" ]]; then
    echo "=== error count at or below $NEAR_ZERO — done ==="
    exit 0
  fi
  if ! kimi_ok; then
    echo "=== kimi quota limited; sleeping 25m ==="
    sleep 1500
    continue
  fi
  MANIFEST="$(mktemp /tmp/deepsec-error-manifest.XXXXXX.json)"
  node "${ROOT}/scripts/audit/deepsec-grok-error-manifest.mjs" "$ROOT" >"$MANIFEST"
  COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).length)")"
  echo "=== manifest $COUNT files $(date -u +%H:%M:%S) ==="
  if [[ "$COUNT" -eq 0 ]]; then
    rm -f "$MANIFEST"
    echo "=== empty manifest but errors=$errs — stopping ==="
    exit 1
  fi
  cd "$WS"
  set +e
  "$DEEPSEC" process --project-id "$PROJECT_ID" \
    --agent "$AGENT" --model "$MODEL" \
    --thinking-level "$DEEPSEC_THINKING" \
    --concurrency "$DEEPSEC_CONCURRENCY" \
    --manifest "$MANIFEST"
  ec=$?
  set -e
  rm -f "$MANIFEST"
  if [[ "$ec" -ne 0 ]] && quota_hit; then
    echo "=== quota during process; sleeping 25m ==="
    sleep 1500
    continue
  fi
  sleep 60
done
