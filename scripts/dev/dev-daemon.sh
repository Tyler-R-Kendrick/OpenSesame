#!/usr/bin/env bash
# npm run dev-daemon — local agent daemon in this process (logs stay attached).
# `daemon start` detaches; this session uses `daemon run` so a crash is visible.
# Default listen is 127.0.0.1:18790. Extra args pass through:
#   npm run dev-daemon -- --listen 127.0.0.1:18790
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source scripts/dev/local-env.sh
if [[ $# -eq 0 ]]; then
  set -- --listen "${OPENSESAME_DAEMON_LISTEN:-127.0.0.1:18790}"
fi
exec cargo +1.88.0 run -p opensesame-cli -- daemon run "$@"
