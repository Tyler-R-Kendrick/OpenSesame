#!/usr/bin/env bash
# Non-interactive Kimi Code CLI for Cloud Agents: OAuth-first, model K3, stream-json.
#
# Auth order (see scripts/dev/kimi-preflight.sh):
#   1. Device OAuth from `kimi login` (~/.kimi-code/credentials/*.json)
#   2. Optional Cursor Runtime Secret KIMI_MODEL_API_KEY (+ KIMI_MODEL_NAME,
#      optional KIMI_MODEL_BASE_URL). Plain KIMI_API_KEY is ignored by Kimi.
#
# By default KIMI_MODEL_* is unset so a runtime API key does not shadow OAuth
# (same idea as scripts/dev/grok-headless.sh). Set KIMI_HEADLESS_PREFER_OAUTH=0
# to keep KIMI_MODEL_* for API-key-only runs.
set -euo pipefail

# OAuth catalog id for Kimi K3 (display name "K3"). Aliases k3 / kimi-k3 alone
# are not registered in config.toml after device login.
KIMI_MODEL_PIN="${KIMI_MODEL_PIN:-kimi-code/k3}"

unset_env=( -u KIMI_API_KEY )
if [[ "${KIMI_HEADLESS_PREFER_OAUTH:-1}" == "1" ]]; then
  unset_env+=( -u KIMI_MODEL_API_KEY -u KIMI_MODEL_NAME -u KIMI_MODEL_BASE_URL )
fi

extra=()
if [[ " $* " != *" --output-format "* ]]; then
  extra+=( --output-format stream-json )
fi
if [[ " $* " != *" -m "* && " $* " != *" --model "* ]]; then
  extra+=( -m "$KIMI_MODEL_PIN" )
fi
# --auto cannot be combined with -p/--prompt (Kimi 2.1.x).
if [[ " $* " != *" -p "* && " $* " != *" --prompt "* ]]; then
  if [[ " $* " != *" --auto"* && " $* " != *" --yolo"* && " $* " != *" -y"* ]]; then
    extra+=( --auto )
  fi
fi

exec env "${unset_env[@]}" kimi "$@" "${extra[@]}"
