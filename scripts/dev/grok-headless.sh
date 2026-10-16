#!/usr/bin/env bash
# Run grok with the Cursor Runtime Secret API keys unset so device OIDC
# (~/.grok/auth.json) is not shadowed. A set XAI_API_KEY wins over device
# login; a depleted key then shows 403 or "Not signed in".
set -euo pipefail
exec env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY grok "$@"
