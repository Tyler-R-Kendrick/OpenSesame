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
echo "== broker adversarial =="
cargo +1.88.0 test -p opensesame-broker --test adversarial_broker
echo "ALL BATTLE TESTS PASSED"
