#!/usr/bin/env bash
# Exit 0 when Kimi subscription quota allows a trivial prompt; 1 when limited.
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY
out="$(mktemp /tmp/deepsec-kimi-probe.XXXXXX.log)"
set +e
timeout 90 kimi -p 'reply ok' >"$out" 2>&1
ec=$?
set -e
if grep -qiE '5-hour usage limit|provider\.auth_error:\s*403|kimi quota or rate limit' "$out"; then
  rm -f "$out"
  exit 1
fi
rm -f "$out"
[[ "$ec" -eq 0 ]]
