#!/usr/bin/env bash
# Verify grok per-file wall helpers (ordered runner uses DEEPSEC_GROK_FILE_WALL_SEC).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
node --experimental-strip-types --test .deepsec/grok-agent-prompt.test.mjs
echo "deepsec-wave2-grok-wall-verify: ok"
