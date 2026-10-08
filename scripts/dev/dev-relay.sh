#!/usr/bin/env bash
# pnpm dev:relay — optional vault-relay peer in this process (ADR 0181).
# Default listen is 127.0.0.1:8787. Extra args replace that:
#   pnpm dev:relay -- --listen 127.0.0.1:8787
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source scripts/dev/local-env.sh
export OPENSESAME_GATEWAY_PROFILE="${OPENSESAME_GATEWAY_PROFILE:-relay}"
if [[ $# -eq 0 ]]; then
  set -- --listen "${OPENSESAME_LISTEN:-127.0.0.1:8787}"
fi
exec cargo +1.88.0 run -p opensesame-cli -- relay run "$@"
