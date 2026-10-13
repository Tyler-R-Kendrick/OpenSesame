#!/usr/bin/env bash
# Wave-2 investigate: Kimi K3 when quota allows, else Cursor Composer on subscription.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
DEEPSEC="${WS}/node_modules/.bin/deepsec"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
export PATH="${HOME}/.local/bin:${PATH}"
export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"
export DEEPSEC_THINKING="${DEEPSEC_THINKING:-medium}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

AGENT="${DEEPSEC_WAVE2_AGENT:-}"
MODEL="${DEEPSEC_WAVE2_MODEL:-}"

if [[ -z "$AGENT" ]]; then
  if "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
    AGENT=kimi
    MODEL=kimi-code/k3
  elif "${ROOT}/scripts/audit/deepsec-cursor-auth-probe.sh"; then
    AGENT=cursor
    MODEL=composer-2.5
  else
    echo "deepsec-wave2-process: no agent (Kimi quota limited; Cursor Agent not authenticated)" >&2
    exit 2
  fi
fi

echo "deepsec-wave2-process: agent=${AGENT} model=${MODEL} wave=${WAVE}"
node "${ROOT}/scripts/audit/deepsec-ingest-native-cli.mjs" "$ROOT" || true
if [[ "$AGENT" == "kimi" ]]; then
  node "${ROOT}/scripts/audit/deepsec-wave2-backfill-kimi-usage.mjs" "$ROOT" "$WAVE" kimi || true
fi
cd "$WS"
"$DEEPSEC" process --project-id opensesame \
  --agent "$AGENT" --model "$MODEL" \
  --thinking-level "$DEEPSEC_THINKING" \
  --concurrency "$DEEPSEC_CONCURRENCY" \
  --reinvestigate "$WAVE"
