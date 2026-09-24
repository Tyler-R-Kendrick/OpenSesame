#!/usr/bin/env bash
# Build every cargo-fuzz target into $OUT for ClusterFuzzLite / OSS-Fuzz.
set -euo pipefail

PROJECT="${SRC:-/src}/opensesame"
cd "$PROJECT"

if ! command -v cargo-fuzz >/dev/null 2>&1; then
  cargo install cargo-fuzz --locked
fi

cargo +nightly fuzz build --release --fuzz-dir tests/fuzz/cargo

OUT="${OUT:-$PROJECT/tests/fuzz/cargo/artifacts}"
mkdir -p "$OUT"

shopt -s nullglob
for bin in tests/fuzz/cargo/target/*/release/*; do
  name="$(basename "$bin")"
  case "$name" in
    *.d|*.rlib|*.so|*.a|incremental|deps|build|examples|native) continue ;;
  esac
  if [[ -x "$bin" && -f "$bin" ]]; then
    cp -f "$bin" "$OUT/$name"
    corpus="tests/fuzz/cargo/corpus/$name"
    if [[ -d "$corpus" ]]; then
      (cd "$corpus" && zip -qr "$OUT/${name}_seed_corpus.zip" .)
    fi
  fi
done
