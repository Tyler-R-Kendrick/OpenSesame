#!/usr/bin/env bash
# cargo clippy gate — matches CI (`-D warnings`) for the full workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/security

echo "==> cargo clippy --workspace --all-targets -- -D warnings"
cargo clippy --workspace --all-targets --message-format=short -- -D warnings \
  2>artifacts/security/clippy.err | tee artifacts/security/clippy.out

if rg -q '^error' artifacts/security/clippy.err; then
  echo "clippy gate: FAIL" >&2
  rg '^error' artifacts/security/clippy.err | head -50 >&2
  exit 1
fi

echo "clippy gate: CLEAN"
