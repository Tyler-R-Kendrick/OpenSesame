#!/usr/bin/env bash
# Long libFuzzer batch over every target. ClusterFuzzLite "batch/cron" analogue.
# Persist corpus growth under fuzz/corpus/. Do not auto-commit it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SECONDS_PER_TARGET="${FUZZ_SECONDS:-3600}"
BUDGET="${FUZZ_BATCH_BUDGET:-}"

if ! cargo fuzz --version >/dev/null 2>&1; then
  echo "fuzz-batch: cargo-fuzz is not installed (cargo install cargo-fuzz)" >&2
  exit 1
fi

start=$(date +%s)
fail=0
for f in fuzz/fuzz_targets/*.rs; do
  target="$(basename "$f" .rs)"
  if [[ -n "$BUDGET" ]]; then
    now=$(date +%s)
    if (( now - start >= BUDGET )); then
      echo "fuzz-batch: budget ${BUDGET}s exhausted after $target"
      break
    fi
  fi
  corpus="fuzz/corpus/$target"
  mkdir -p "$corpus" fuzz/artifacts
  echo "==> $target (${SECONDS_PER_TARGET}s)"
  if ! cargo fuzz run "$target" --fuzz-dir fuzz -- \
      -max_total_time="$SECONDS_PER_TARGET" \
      -timeout=10 \
      -artifact_prefix="$ROOT/fuzz/artifacts/" \
      "$corpus"; then
    echo "fuzz-batch: CRASH $target — copy a minimized input into fuzz/regressions/$target/" >&2
    mkdir -p "fuzz/regressions/$target"
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "fuzz-batch: FAIL" >&2
  exit 1
fi
echo "fuzz-batch: CLEAN"
