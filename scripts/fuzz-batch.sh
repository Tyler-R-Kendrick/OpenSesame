#!/usr/bin/env bash
# Long libFuzzer batch over every target. ClusterFuzzLite "batch/cron" analogue.
# Persist corpus growth in the reported private audit directory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/fuzz-directory.sh"

SECONDS_PER_TARGET="${FUZZ_SECONDS:-3600}"
BUDGET="${FUZZ_BATCH_BUDGET:-}"

if ! cargo +nightly fuzz --version >/dev/null 2>&1; then
  echo "fuzz-batch: cargo-fuzz is not installed (cargo install cargo-fuzz)" >&2
  exit 1
fi

cargo +nightly metadata --format-version 1 --manifest-path fuzz/Cargo.toml --locked --no-deps >/dev/null

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
  opensesame_fuzz_corpus "$target"
  echo "==> $target (${SECONDS_PER_TARGET}s)"
  if ! cargo +nightly fuzz run "$target" --fuzz-dir fuzz "$corpus" -- \
      -max_total_time="$SECONDS_PER_TARGET" \
      -timeout=10 \
      -artifact_prefix="$OPENSESAME_AUDIT_DIR/artifacts/" \
      > "$OPENSESAME_AUDIT_DIR/$target.log" 2>&1; then
    echo "fuzz-batch: CRASH $target — inspect private artifacts at $OPENSESAME_AUDIT_DIR" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "fuzz-batch: FAIL" >&2
  exit 1
fi
echo "fuzz-batch: CLEAN"
