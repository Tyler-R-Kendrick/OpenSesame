#!/usr/bin/env bash
# Subscription auth only (~/.grok/auth.json). Never use XAI_API_KEY.
# Unset API keys so a runtime secret cannot shadow the subscription login.
set -euo pipefail
exec env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY -u GROK_DEPLOYMENT_KEY grok "$@"
