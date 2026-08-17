#!/usr/bin/env bash
# Validate the default GitHub history scenario: private opensesame-passwords repo.
# Used by the agent loop — must stay green without live GitHub credentials.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== github-history private-repo defaults (Pages) =="
pnpm --filter @opensesame/pages exec vitest run \
  src/lib/github-history.test.ts \
  src/lib/capabilities.test.ts

echo "== connection-broker egress parse (private repo) =="
cargo +1.88.0 test -p opensesame-connection-broker egress --lib --quiet

echo "== gateway routes compile =="
cargo +1.88.0 check -p opensesame-gateway --quiet

echo "OK: private GitHub password-store remote remains the default validated path"
