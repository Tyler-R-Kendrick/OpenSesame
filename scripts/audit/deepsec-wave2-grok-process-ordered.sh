#!/usr/bin/env bash
# Run Grok wave-2 in manifest order (one file per deepsec process).
# deepsec re-sorts by candidate count and pre-locks the whole manifest; slicing avoids both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
PERSIST_TIER_STATE="${ROOT}/.deepsec/wave2-grok-tier-state.json"
STATE_TIER=""
if [[ -f "$PERSIST_TIER_STATE" ]]; then
  STATE_TIER="$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const t = s.currentTier;
    process.stdout.write(t === 1 || t === 2 || t === 3 ? String(t) : '');
  " "$PERSIST_TIER_STATE")"
fi
if [[ -n "$STATE_TIER" && ( -z "${DEEPSEC_GROK_TIER:-}" || "${DEEPSEC_GROK_TIER}" == "all" ) ]]; then
  GROK_TIER="$STATE_TIER"
else
  GROK_TIER="${DEEPSEC_GROK_TIER:-all}"
fi
export PATH="${HOME}/.local/bin:${PATH}"
# Force wave-2 ordered thresholds (parent tier-run may export 60/600).
export DEEPSEC_GROK_SHALLOW_MAX_TURNS=30
export DEEPSEC_GROK_SHALLOW_TIMEOUT_SEC=420
export DEEPSEC_GROK_RESCUE_MAX_TURNS=20
export DEEPSEC_GROK_RESCUE_TIMEOUT_SEC=420
export DEEPSEC_GROK_COMPACT_RESCUE_MAX_TURNS=12
export DEEPSEC_GROK_COMPACT_RESCUE_TIMEOUT_SEC=180
export DEEPSEC_GROK_DEEP_MAX_TURNS="${DEEPSEC_GROK_DEEP_MAX_TURNS:-150}"
export DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC="${DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC:-2700}"
export DEEPSEC_GROK_FILE_WALL_SEC="${DEEPSEC_GROK_FILE_WALL_SEC:-2700}"
export DEEPSEC_GROK_DEEP_TIMEOUT_SEC="${DEEPSEC_GROK_DEEP_TIMEOUT_SEC:-1800}"
export DEEPSEC_GROK_USE_COREUTILS_TIMEOUT="${DEEPSEC_GROK_USE_COREUTILS_TIMEOUT:-1}"
export DEEPSEC_GROK_ORDERED_SKIP_DEEP="${DEEPSEC_GROK_ORDERED_SKIP_DEEP:-1}"
ORDERED_PROCESS_TIMEOUT_SEC="${DEEPSEC_GROK_ORDERED_PROCESS_TIMEOUT_SEC:-$((DEEPSEC_GROK_FILE_WALL_SEC + 300))}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

read -r AGENT MODEL < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh") || exit 2
[[ "$AGENT" == "grok" ]] || { echo "ordered grok process: agent=$AGENT" >&2; exit 1; }

node "${ROOT}/scripts/audit/deepsec-wave2-reconcile-stale-runs.mjs" "$ROOT" || true
node "${ROOT}/scripts/audit/deepsec-wave2-reconcile-file-locks.mjs" "$ROOT" || true

ORDERED="$(mktemp /tmp/deepsec-wave2-grok-ordered.XXXXXX.json)"
node "${ROOT}/scripts/audit/deepsec-wave2-grok-manifest.mjs" "$ROOT" "$WAVE" "$GROK_TIER" >"$ORDERED"
TOTAL="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$ORDERED")"
echo "deepsec-wave2-grok-process-ordered: tier=${GROK_TIER} files=${TOTAL} manifest=${ORDERED}"

SLICE="$(mktemp /tmp/deepsec-wave2-grok-slice.XXXXXX.json)"
idx=0
while [[ "$idx" -lt "$TOTAL" ]]; do
  node -e "
    const paths = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const i = Number(process.argv[2]);
    require('fs').writeFileSync(process.argv[3], JSON.stringify([paths[i]]));
  " "$ORDERED" "$idx" "$SLICE"
  path="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[0])" "$SLICE")"
  echo "deepsec-wave2-grok-process-ordered: file $((idx + 1))/${TOTAL} ${path}"
  node "${ROOT}/scripts/audit/deepsec-wave2-reconcile-file-locks.mjs" "$ROOT" || true
  cd "$WS"
  if ! timeout -k 30 "$ORDERED_PROCESS_TIMEOUT_SEC" "$DEEPSEC" process --project-id opensesame \
    --agent "$AGENT" --model "$MODEL" \
    --thinking-level "${DEEPSEC_THINKING:-medium}" \
    --concurrency 1 \
    --reinvestigate "$WAVE" \
    --batch-size 1 \
    --max-turns "${DEEPSEC_GROK_SHALLOW_MAX_TURNS:-60}" \
    --manifest "$SLICE"; then
    reason="process_exit"
    if tail -20 "$LOG" 2>/dev/null | grep -q 'file wall exceeded'; then
      reason="file_wall_exceeded"
    fi
    node "${ROOT}/scripts/audit/deepsec-wave2-grok-deferred.mjs" path "$ROOT" "$path" "$reason"
    echo "deepsec-wave2-grok-process-ordered: deferred ${path} (${reason}) — continuing"
  fi
  idx=$((idx + 1))
done
rm -f "$SLICE" "$ORDERED"
