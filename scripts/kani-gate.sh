#!/usr/bin/env bash
# Bounded Kani proofs on pure security-critical functions.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v cargo >/dev/null 2>&1; then
  echo "kani-gate: cargo not on PATH" >&2
  exit 1
fi

if ! cargo kani --version >/dev/null 2>&1; then
  echo "kani-gate: Kani is not installed." >&2
  echo "  cargo install --locked kani-verifier && cargo kani setup" >&2
  echo "This gate is optional and is not part of pnpm verify." >&2
  exit 1
fi

echo "==> cargo kani (grant boundaries, rotation state machine)"
cargo kani \
  -p opensesame-domain \
  -p opensesame-rotation \
  --lib

echo "kani-gate: CLEAN"
