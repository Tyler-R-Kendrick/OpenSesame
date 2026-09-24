#!/usr/bin/env bash
# setup-hooks.sh — point git at the repo's tracked hooks and make them executable.
# Idempotent: safe to re-run any number of times.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push scripts/setup-hooks.sh

echo "setup-hooks: git core.hooksPath -> .githooks (pre-commit, pre-push installed)"
