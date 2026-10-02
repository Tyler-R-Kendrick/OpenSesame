#!/usr/bin/env bash
# npm run dev:host — Host API in this process (logs stay attached).
# Default listen is 127.0.0.1:8787. Extra args replace that:
#   npm run dev:host -- --listen 127.0.0.1:8787
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source scripts/dev/local-env.sh
if [[ $# -eq 0 ]]; then
  set -- --listen "${OPENSESAME_LISTEN:-127.0.0.1:8787}"
fi
exec cargo +1.88.0 run -p opensesame-cli -- host run "$@"
