#!/usr/bin/env bash
# Exit 0 when Grok Build (subscription) accepts a trivial prompt; 1 when not signed in or capped.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY
MODEL="${DEEPSEC_GROK_MODEL:-grok-4.7}"
out="$(mktemp /tmp/deepsec-grok-probe.XXXXXX.log)"
set +e
timeout -k 10 120 grok -p 'reply ok' -m "$MODEL" --always-approve --output-format plain >"$out" 2>&1
ec=$?
set -e
if grep -qiE 'Not signed in|login --device|unauthorized|401' "$out"; then
  cat "$out" >>/tmp/deepsec-grok-probe.log 2>/dev/null || true
  rm -f "$out"
  exit 1
fi
if grep -qiE 'usage limit|rate limit|quota|403|429' "$out"; then
  cat "$out" >>/tmp/deepsec-grok-probe.log 2>/dev/null || true
  rm -f "$out"
  exit 1
fi
rm -f "$out"
[[ "$ec" -eq 0 ]]
