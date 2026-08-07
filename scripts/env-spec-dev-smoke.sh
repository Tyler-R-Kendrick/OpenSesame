#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -q -p opensesame-cli
BIN=./target/debug/opensesame
SCHEMA=fixtures/demo.env.schema
OUT=$("$BIN" dev check --schema "$SCHEMA")
echo "$OUT" | grep -q STRIPE_SECRET_KEY
# Must not leak a live-looking secret value from the fixture
if echo "$OUT" | grep -E 'sk_live_|rk_live_|password=.+[^"]' >/dev/null; then
  echo "dev check leaked secret-like material" >&2
  exit 1
fi
OUT2=$("$BIN" dev resolve --agent --schema "$SCHEMA")
echo "$OUT2" | grep -q '"agent": true'
echo "$OUT2" | grep -q Placeholder || echo "$OUT2" | grep -qi placeholder
echo "env-spec-dev-smoke OK"
