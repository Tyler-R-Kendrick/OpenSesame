#!/usr/bin/env bash
# Pick wave-2 investigate agent: Grok Build (grok-4.7) → Kimi K3 → Cursor Composer.
# Subscription only — never XAI_API_KEY / Moonshot / gateway keys.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

if [[ -n "${DEEPSEC_WAVE2_AGENT:-}" ]]; then
  AGENT="$DEEPSEC_WAVE2_AGENT"
  MODEL="${DEEPSEC_WAVE2_MODEL:-}"
  case "$AGENT" in
    grok) MODEL="${MODEL:-grok-4.7}" ;;
    kimi) MODEL="${MODEL:-kimi-code/k3}" ;;
    cursor) MODEL="${MODEL:-composer-2.5}" ;;
    *)
      echo "deepsec-wave2-pick-agent: unknown DEEPSEC_WAVE2_AGENT=$AGENT" >&2
      exit 2
      ;;
  esac
  echo "$AGENT $MODEL"
  exit 0
fi

if "${ROOT}/scripts/audit/deepsec-grok-quota-probe.sh"; then
  echo "grok grok-4.7"
  exit 0
fi
if "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
  echo "kimi kimi-code/k3"
  exit 0
fi
if "${ROOT}/scripts/audit/deepsec-cursor-auth-probe.sh"; then
  echo "cursor composer-2.5"
  exit 0
fi
echo "deepsec-wave2-pick-agent: no agent (Grok not available; Kimi quota limited; Cursor not authenticated)" >&2
exit 2
