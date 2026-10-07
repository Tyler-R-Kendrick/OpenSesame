#!/usr/bin/env bash
# Normal stable libtest replay, independently required before canonical fuzzing.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
: "${TEST_DEPTH_EVIDENCE:?private hosted evidence directory required}"
[[ -z "${RUSTC_BOOTSTRAP:-}" ]] || { echo 'Refusing bootstrap compiler substitution' >&2; exit 2; }
evidence="$TEST_DEPTH_EVIDENCE/retired-oracle-regressions"
test ! -e "$evidence"
mkdir -m 700 "$evidence"
cargo +1.88.0 --version > "$evidence/cargo-version.txt"
rustc +1.88.0 --version > "$evidence/rustc-version.txt"
git rev-parse HEAD HEAD^{tree} > "$evidence/source.txt"
sha256sum tests/fuzz/cargo/Cargo.toml tests/fuzz/cargo/Cargo.lock tests/fuzz/cargo/tests/retired_oracle_regressions.rs > "$evidence/inputs.sha256"
printf '%s\n' 'cargo +1.88.0 test --locked --manifest-path tests/fuzz/cargo/Cargo.toml --test retired_oracle_regressions -- --color never --test-threads=1' > "$evidence/command.txt"
set +e
# Default libtest output capture keeps successful case identities contiguous.
cargo +1.88.0 test --locked --manifest-path tests/fuzz/cargo/Cargo.toml --test retired_oracle_regressions -- --color never --test-threads=1 2>&1 | tee "$evidence/run.log"
statuses=("${PIPESTATUS[@]}")
set -e
printf '%s\n' "${statuses[0]}" > "$evidence/cargo.exit"
printf '%s\n' "${statuses[1]}" > "$evidence/log.exit"
python3 -B scripts/quality/rust-normal-regression-report.py "$evidence/run.log" "$evidence/cargo.exit" "$evidence/results.json"
test "${statuses[0]}:${statuses[1]}" = 0:0
