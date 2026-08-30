#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export OPENSESAME_DEBUG_RUN="${OPENSESAME_DEBUG_RUN:-battle-manual}"
echo "== unit + adversarial libs =="
cargo +1.88.0 test --lib \
  -p opensesame-domain \
  -p opensesame-authn \
  -p opensesame-authz \
  -p opensesame-redaction \
  -p opensesame-human-vault \
  -p opensesame-connector-host \
  -p opensesame-rotation \
  -p opensesame-audit \
  -p opensesame-claims \
  -p opensesame-storage \
  -p opensesame-provider-openbao
echo "== topology cores =="
cargo +1.88.0 test --lib \
  -p opensesame-core \
  -p opensesame-host-core \
  -p opensesame-client-core \
  -p opensesame-env-spec
echo "== wasm client-core =="
./scripts/wasm-client-core-smoke.sh
echo "== wasm connector runtime (ADR 0061, feature-gated) =="
cargo +1.88.0 test -p opensesame-connector-host --features wasm-connectors
echo "== broker adversarial =="
cargo +1.88.0 test -p opensesame-broker --test adversarial_broker
echo "== api-client + MCP =="
pnpm --filter @opensesame/api-client test
pnpm --filter @opensesame/mcp-client test
pnpm --filter @opensesame/mcp-host test
echo "ALL BATTLE TESTS PASSED"
