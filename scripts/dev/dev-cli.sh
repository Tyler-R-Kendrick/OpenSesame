#!/usr/bin/env bash
# npm run dev-cli — native OpenSesame CLI in the foreground.
# No arguments keeps the session up as the Host API (this binary's long-running
# role beside the daemon): `opensesame host run` on 127.0.0.1:8787.
# A subcommand runs that verb instead: npm run dev-cli -- status
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source scripts/dev/local-env.sh
if [[ $# -eq 0 ]]; then
  set -- host run --listen "${OPENSESAME_LISTEN:-127.0.0.1:8787}"
fi
exec cargo +1.88.0 run -p opensesame-cli -- "$@"
