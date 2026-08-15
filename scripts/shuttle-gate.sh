#!/usr/bin/env bash
# Shuttle schedule exploration for broker/rotation/replay races.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ITERATIONS="${SHUTTLE_ITERATIONS:-1000}"

echo "==> shuttle tests (iterations=$ITERATIONS)"
SHUTTLE_ITERATIONS="$ITERATIONS" cargo test -p opensesame-broker --features concurrency-test --test shuttle_idempotency -- --nocapture
SHUTTLE_ITERATIONS="$ITERATIONS" cargo test -p opensesame-proof --features concurrency-test --test shuttle_replay -- --nocapture
SHUTTLE_ITERATIONS="$ITERATIONS" cargo test -p opensesame-rotation --features concurrency-test --test shuttle_rotation -- --nocapture

echo "shuttle-gate: CLEAN"
