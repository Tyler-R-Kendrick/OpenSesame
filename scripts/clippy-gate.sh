#!/usr/bin/env bash
# Rust formatting and Clippy gate for the full workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/security

echo "==> cargo +1.88.0 fmt --all -- --check"
cargo +1.88.0 fmt --all -- --check

echo "==> cargo +1.88.0 clippy --workspace --all-targets --all-features"
cargo +1.88.0 clippy --workspace --all-targets --all-features --message-format=short -- \
  -D warnings \
  -D clippy::pedantic \
  -D clippy::cognitive_complexity \
  -D clippy::excessive_nesting \
  -D clippy::too_many_lines \
  -D clippy::too_many_arguments \
  -D clippy::type_complexity \
  2>artifacts/security/clippy.err | tee artifacts/security/clippy.out

if rg -q '^error' artifacts/security/clippy.err; then
  echo "clippy gate: FAIL" >&2
  rg '^error' artifacts/security/clippy.err | head -50 >&2
  exit 1
fi

echo "clippy gate: CLEAN"
