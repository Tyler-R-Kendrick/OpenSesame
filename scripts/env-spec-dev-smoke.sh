#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -q -p opensesame-cli
BIN=./target/debug/opensesame
SCHEMA=fixtures/demo.env.schema
OUT=$("$BIN" dev check --schema "$SCHEMA")
echo "$OUT" | grep -q STRIPE_SECRET_KEY
if echo "$OUT" | grep -E 'sk_live_|rk_live_|password=.+[^"]' >/dev/null; then
  echo "dev check leaked secret-like material" >&2
  exit 1
fi
OUT2=$("$BIN" dev resolve --mode agent --schema "$SCHEMA")
echo "$OUT2" | grep -q '"agent": true'
echo "$OUT2" | grep -qi placeholder

# Child env under --agent must carry shaped placeholders, not live secrets from fixture values.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
"$BIN" dev run --mode agent --schema "$SCHEMA" -- sh -c 'env' >"$TMP"
if grep -E 'sk_live_|LIVE_SECRET|supersecret' "$TMP" >/dev/null; then
  echo "dev run --agent leaked live secret into child env" >&2
  cat "$TMP" >&2
  exit 1
fi
# Expect at least one sk_ shaped placeholder or conn:// handle from fixture projections
if ! grep -E 'sk_|conn://' "$TMP" >/dev/null; then
  echo "dev run --agent missing placeholder/handle projections" >&2
  cat "$TMP" >&2
  exit 1
fi
echo "env-spec-dev-smoke OK"
