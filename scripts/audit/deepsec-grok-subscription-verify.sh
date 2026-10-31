#!/usr/bin/env bash
# Prove DeepSec Grok runs bill against Grok Build CLI subscription, not XAI_API_KEY.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MODEL="${DEEPSEC_GROK_MODEL:-grok-4.7}"

unset XAI_API_KEY GROK_CODE_XAI_API_KEY GROK_DEPLOYMENT_KEY

if [[ -n "${XAI_API_KEY:-}" || -n "${GROK_CODE_XAI_API_KEY:-}" ]]; then
  echo "deepsec-grok-subscription-verify: pay-per-token keys must be unset in this shell" >&2
  exit 1
fi

bash "${ROOT}/scripts/dev/grok-install-subscription-auth.sh"
bash "${ROOT}/scripts/dev/grok-preflight.sh"

if ! command -v grok >/dev/null 2>&1; then
  echo "deepsec-grok-subscription-verify: grok CLI not on PATH" >&2
  exit 1
fi

probe="$(
  env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY -u GROK_DEPLOYMENT_KEY \
    "${ROOT}/scripts/dev/grok-headless.sh" \
    -p "Reply exactly: SUBSCRIPTION_OK" \
    -m "$MODEL" \
    --always-approve \
    --output-format json 2>&1
)" || true

if ! echo "$probe" | grep -q "SUBSCRIPTION_OK"; then
  echo "deepsec-grok-subscription-verify: grok subscription probe failed" >&2
  echo "${probe:0:400}" >&2
  exit 1
fi

cat <<EOF
deepsec-grok-subscription-verify: OK
  billing: Grok Build CLI subscription (~/.grok/auth.json)
  model: ${MODEL}
  deepsec agent: grok (custom plugin .deepsec/grok-agent-plugin.ts)
  not used: XAI_API_KEY, pi/Vercel AI Gateway, codex/claude API billing

Stock deepsec 2.x built-in agents: codex, claude, pi (gateway or provider API keys).
OpenSesame adds --agent grok via deepsec.config.ts plugin only.
Run AI investigate with:
  export DEEPSEC_AGENT=grok DEEPSEC_GROK_MODEL=${MODEL}
  unset XAI_API_KEY GROK_CODE_XAI_API_KEY GROK_DEPLOYMENT_KEY
  bash scripts/audit/deepsec-grok-subscription-verify.sh
  bash scripts/audit/deepsec-grok-scan.sh process
EOF
