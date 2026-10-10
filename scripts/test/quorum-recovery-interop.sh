#!/usr/bin/env bash
# Trusted-contacts recovery, TypeScript and Rust each against the other's output
# (ADR 0187 follow-up 3, ADR 0139):
#   1. TypeScript writes a fresh two-epoch circle to a temp directory;
#   2. the native reader (crates/quorum-recovery) recombines and opens it, then
#      writes a bundle with natively made shares and releases of its own;
#   3. TypeScript opens those.
# The committed fixture's drift tests run in the ordinary suites on both sides
# (`vitest run src/lib/quorum`, `cargo test -p opensesame-quorum-recovery`);
# this script is the live half, with fresh randomness every run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# One shared cargo target dir for every worktree (AGENTS.md section 9).
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"

umask 077
OPENSESAME_QUORUM_INTEROP_DIR="$(mktemp -d)"
export OPENSESAME_QUORUM_INTEROP_DIR
trap 'rm -rf "$OPENSESAME_QUORUM_INTEROP_DIR"' EXIT

ts_phase() {
  OPENSESAME_QUORUM_INTEROP_PHASE="$1" pnpm --filter @opensesame/app-core exec \
    vitest run src/lib/quorum/recovery-fixture.test.ts
}

echo "==> 1/3 TypeScript writes a circle"
ts_phase produce

echo "==> 2/3 the native reader opens it and writes its own"
cargo +1.88.0 test -p opensesame-quorum-recovery --test interop -- --ignored

echo "==> 3/3 TypeScript opens what the native reader wrote"
ts_phase consume

echo "quorum recovery interop: OK"
