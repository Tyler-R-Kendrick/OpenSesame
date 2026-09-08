#!/usr/bin/env bash
# Rust formatting and Clippy gate for the full workspace.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory

echo "==> cargo +1.88.0 fmt --all -- --check"
cargo +1.88.0 fmt --all -- --check

echo "==> cargo +1.88.0 clippy --workspace --all-targets --all-features"
if cargo +1.88.0 clippy --workspace --all-targets --all-features --message-format=short -- \
  -D warnings \
  -D clippy::pedantic \
  -D clippy::cognitive_complexity \
  -D clippy::excessive_nesting \
  -D clippy::too_many_lines \
  -D clippy::too_many_arguments \
  -D clippy::type_complexity \
  2>"$OPENSESAME_AUDIT_DIR/clippy.err" | tee "$OPENSESAME_AUDIT_DIR/clippy.out"; then
  echo "clippy gate: CLEAN"
else
  clippy_status=$?
  echo "clippy gate: FAIL" >&2
  tail -50 "$OPENSESAME_AUDIT_DIR/clippy.err" >&2
  exit "$clippy_status"
fi
