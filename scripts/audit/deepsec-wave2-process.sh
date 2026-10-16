#!/usr/bin/env bash
# Wave-2 investigate: Grok Build grok-4.7 → Kimi K3 → Cursor Composer (subscription only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
export PATH="${HOME}/.local/bin:${PATH}"
if [[ -f /tmp/deepsec-wave2-concurrency-choice.env ]]; then
  # shellcheck source=/dev/null
  source /tmp/deepsec-wave2-concurrency-choice.env
fi
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-4}"
export DEEPSEC_BATCH_SIZE="${DEEPSEC_BATCH_SIZE:-1}"
export DEEPSEC_GROK_SHALLOW_MAX_TURNS="${DEEPSEC_GROK_SHALLOW_MAX_TURNS:-60}"
export DEEPSEC_GROK_DEEP_MAX_TURNS="${DEEPSEC_GROK_DEEP_MAX_TURNS:-150}"
export DEEPSEC_GROK_MAX_TURNS="${DEEPSEC_GROK_MAX_TURNS:-$DEEPSEC_GROK_SHALLOW_MAX_TURNS}"
export DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC="${DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC:-2700}"
export DEEPSEC_GROK_FILE_WALL_SEC="${DEEPSEC_GROK_FILE_WALL_SEC:-2700}"
export DEEPSEC_GROK_SHALLOW_TIMEOUT_SEC="${DEEPSEC_GROK_SHALLOW_TIMEOUT_SEC:-600}"
export DEEPSEC_GROK_DEEP_TIMEOUT_SEC="${DEEPSEC_GROK_DEEP_TIMEOUT_SEC:-1800}"
export DEEPSEC_GROK_MANIFEST_SORT="${DEEPSEC_GROK_MANIFEST_SORT:-size}"
export DEEPSEC_GROK_USE_COREUTILS_TIMEOUT="${DEEPSEC_GROK_USE_COREUTILS_TIMEOUT:-1}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

read -r AGENT MODEL < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh") || exit 2

echo "deepsec-wave2-process: agent=${AGENT} model=${MODEL} wave=${WAVE}"
node "${ROOT}/scripts/audit/deepsec-ingest-native-cli.mjs" "$ROOT" || true
if [[ "$AGENT" == "kimi" ]]; then
  node "${ROOT}/scripts/audit/deepsec-wave2-backfill-kimi-usage.mjs" "$ROOT" "$WAVE" kimi || true
fi
cd "$WS"
MANIFEST_ARGS=()
if [[ "$AGENT" == "grok" ]]; then
  if [[ "${DEEPSEC_GROK_TIER:-}" == "1" ]]; then
    export DEEPSEC_CONCURRENCY="${DEEPSEC_GROK_TIER1_CONCURRENCY:-2}"
  fi
  GROK_TIER="${DEEPSEC_GROK_TIER:-all}"
  if [[ "${DEEPSEC_GROK_ORDERED_SLICES:-1}" == "1" ]]; then
    exec "${ROOT}/scripts/audit/deepsec-wave2-grok-process-ordered.sh"
  fi
  MANIFEST="$(mktemp /tmp/deepsec-wave2-grok-manifest.XXXXXX.json)"
  node "${ROOT}/scripts/audit/deepsec-wave2-grok-manifest.mjs" "$ROOT" "$WAVE" "$GROK_TIER" >"$MANIFEST"
  MANIFEST_COUNT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$MANIFEST")"
  echo "deepsec-wave2-process: grok manifest tier=${GROK_TIER} $MANIFEST_COUNT files (pending grok marker-$WAVE)"
  MANIFEST_ARGS=(--manifest "$MANIFEST")
fi
PROCESS_EXTRA=()
if [[ "$AGENT" == "grok" ]]; then
  node "${ROOT}/scripts/audit/deepsec-wave2-reconcile-stale-runs.mjs" "$ROOT" || true
  node "${ROOT}/scripts/audit/deepsec-wave2-reconcile-file-locks.mjs" "$ROOT" || true
  node "${ROOT}/scripts/audit/deepsec-wave2-backfill-grok-deep-usage.mjs" "$ROOT" "$WAVE" || true
  node "${ROOT}/scripts/audit/deepsec-wave2-grok-depth-sweep.mjs" "$ROOT" "$WAVE" || true
  node "${ROOT}/scripts/audit/deepsec-wave2-grok-depth-summary.mjs" "$ROOT" "$WAVE" || true
  PROCESS_EXTRA=(--batch-size "$DEEPSEC_BATCH_SIZE" --max-turns "$DEEPSEC_GROK_SHALLOW_MAX_TURNS")
  echo "deepsec-wave2-process: grok concurrency=${DEEPSEC_CONCURRENCY} batch_size=${DEEPSEC_BATCH_SIZE} shallow_turns=${DEEPSEC_GROK_SHALLOW_MAX_TURNS} deep_turns=${DEEPSEC_GROK_DEEP_MAX_TURNS} invoke_timeout_sec=${DEEPSEC_GROK_INVESTIGATE_TIMEOUT_SEC} file_wall_sec=${DEEPSEC_GROK_FILE_WALL_SEC} shallow_timeout_sec=${DEEPSEC_GROK_SHALLOW_TIMEOUT_SEC} deep_timeout_sec=${DEEPSEC_GROK_DEEP_TIMEOUT_SEC} coreutils_timeout=${DEEPSEC_GROK_USE_COREUTILS_TIMEOUT}"
fi
"$DEEPSEC" process --project-id opensesame \
  --agent "$AGENT" --model "$MODEL" \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" \
  --reinvestigate "$WAVE" \
  "${PROCESS_EXTRA[@]}" \
  "${MANIFEST_ARGS[@]}"
