#!/usr/bin/env bash
# npm run dev:cli — native `opensesame` CLI.
# Arguments are the CLI verb: npm run dev:cli -- status
# The Host API is `npm run dev:host`.
set -euo pipefail
cd "$(dirname "$0")/../.."
# shellcheck disable=SC1091
source scripts/dev/local-env.sh
exec cargo +1.88.0 run -p opensesame-cli -- "$@"
