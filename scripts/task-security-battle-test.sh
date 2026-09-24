#!/usr/bin/env bash
# Task-scoped authority battle tests (no cloud credentials).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== domain / proof / task-access / protocol / broker =="
cargo +1.88.0 test -p opensesame-domain -p opensesame-proof -p opensesame-task-access \
  -p opensesame-protocol-mcp -p opensesame-broker --quiet

echo "== aauth experimental adapter =="
cargo +1.88.0 test -p opensesame-protocol-aauth --features experimental-aauth --quiet

echo "== gateway compiles with task routes =="
cargo +1.88.0 check -p opensesame-gateway --quiet

echo "== cli + proof + task-access =="
cargo +1.88.0 test -p opensesame-proof -p opensesame-task-access -p opensesame-cli --quiet

echo "== mcp-host + console =="
pnpm --filter @opensesame/mcp-host test
pnpm --filter @opensesame/console test

echo "task-security-battle-test: OK"
