#!/usr/bin/env bash
# Exit 0 when Cursor Agent CLI is installed and can run composer-2.5 (subscription auth).
# Does not use XAI_API_KEY, AI Gateway, or Moonshot keys.
set -euo pipefail
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

if ! command -v cursor-agent >/dev/null 2>&1 && ! command -v agent >/dev/null 2>&1; then
  exit 1
fi

BIN="$(command -v cursor-agent 2>/dev/null || command -v agent)"
if ! "$BIN" status 2>&1 | grep -qiE 'logged in|authenticated'; then
  exit 1
fi

out="$(mktemp /tmp/deepsec-cursor-probe.XXXXXX.log)"
set +e
timeout 120 "$BIN" -p 'Reply with exactly: ok' --model composer-2.5 --print --force >"$out" 2>&1
ec=$?
set -e
if [[ "$ec" -ne 0 ]]; then
  rm -f "$out"
  exit 1
fi
if ! grep -qi 'ok' "$out"; then
  rm -f "$out"
  exit 1
fi
rm -f "$out"
exit 0
