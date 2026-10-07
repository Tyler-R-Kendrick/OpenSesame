#!/usr/bin/env bash
# Separate additive depth gates: no edits to canonical coverage/mutation/fuzz policies.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
family="${1:?coverage, mutation-core, mutation-adapters or fuzz required}"
: "${TEST_DEPTH_EVIDENCE:?fresh private evidence directory required}"
: "${RUNNER_TEMP:?runner temporary directory required}"
mkdir -p "$TEST_DEPTH_EVIDENCE/commands"
report=scripts/quality/credential-rust-report.py
config=tools/mutation/credential-rust-depth.json
run_record() {
  local name="$1"
  shift
  local -a statuses
  set +e
  "$@" 2>&1 | tee "$TEST_DEPTH_EVIDENCE/commands/$name.log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  printf '%s\n' "${statuses[0]}" > "$TEST_DEPTH_EVIDENCE/commands/$name.exit"
  printf '%s\n' "${statuses[1]}" > "$TEST_DEPTH_EVIDENCE/commands/$name.log.exit"
  test "${statuses[0]}:${statuses[1]}" = 0:0
}
case "$family" in
  coverage)
    run_record coverage cargo +1.88.0 llvm-cov --locked \
      -p opensesame-human-vault -p opensesame-authenticator-core -p opensesame-sealed-store \
      --all-targets --json --output-path "$TEST_DEPTH_EVIDENCE/llvm.json"
    python3 -B "$report" coverage "$TEST_DEPTH_EVIDENCE/llvm.json" "$TEST_DEPTH_EVIDENCE/coverage.json"
    ;;
  mutation-core|mutation-adapters)
    group="${family#mutation-}"
    mapfile -t packages < <(python3 -B -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))[sys.argv[2]]["packages"]))' "$config" "$group")
    mapfile -t files < <(python3 -B -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))[sys.argv[2]]["files"]))' "$config" "$group")
    (( ${#packages[@]} > 0 && ${#files[@]} > 0 ))
    args=(--gitignore true)
    for package in "${packages[@]}"; do args+=(-p "$package"); done
    for file in "${files[@]}"; do args+=(--file "$file"); done
    # Tool defaults and all authored tests' deadlines remain unchanged.
    list_mutants() { cargo +1.88.0 mutants "${args[@]}" --list > "$TEST_DEPTH_EVIDENCE/selection.txt"; }
    run_record selection list_mutants
    python3 -B "$report" mutation-list "$TEST_DEPTH_EVIDENCE/selection.txt" "$TEST_DEPTH_EVIDENCE/selection.json" --group "$group"
    run_record mutation cargo +1.88.0 mutants "${args[@]}" -j 2 -o "$TEST_DEPTH_EVIDENCE/mutants"
    python3 -B "$report" mutation-run "$TEST_DEPTH_EVIDENCE/commands/mutation.log" "$TEST_DEPTH_EVIDENCE/mutation.json"
    ;;
  fuzz)
    target="${2:?explicit credential fuzz target required}"
    case "$target" in retired_records_parse|canary_registry_validator|observation_wire|observation_outbox_fsm) ;; *) exit 2 ;; esac
    seconds="${FUZZ_SECONDS:-60}"
    [[ "$seconds" =~ ^[1-9][0-9]{0,3}$ ]] && ((seconds <= 3600))
    toolchain=nightly-2026-10-06
    run_record metadata cargo "+$toolchain" metadata --locked --format-version 1 --no-deps --manifest-path tests/fuzz/credentials-cargo/Cargo.toml
    run_record controls cargo "+$toolchain" test --locked --manifest-path tests/fuzz/credentials-cargo/Cargo.toml --test credential_oracle_controls
    python3 -B "$report" rust-controls "$TEST_DEPTH_EVIDENCE/commands/controls.log" "$TEST_DEPTH_EVIDENCE/controls.json"
    corpus="$TEST_DEPTH_EVIDENCE/corpus/$target"
    mkdir -p "$corpus" "$TEST_DEPTH_EVIDENCE/artifacts"
    cp -a "tests/fuzz/credentials-cargo/credential_corpus/$target/." "$corpus/"
    run_record fuzz cargo "+$toolchain" fuzz run "$target" --fuzz-dir tests/fuzz/credentials-cargo "$corpus" -- \
      -max_total_time="$seconds" -timeout=10 -max_len=131073 \
      -artifact_prefix="$TEST_DEPTH_EVIDENCE/artifacts/"
    python3 -B "$report" fuzz-run "$TEST_DEPTH_EVIDENCE/commands/fuzz.log" "$TEST_DEPTH_EVIDENCE/fuzz.json"
    ;;
  *) exit 2 ;;
esac
