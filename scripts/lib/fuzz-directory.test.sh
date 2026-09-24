#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fixture="$(mktemp -d /tmp/opensesame-fuzz-test.XXXXXXXX)"
ROOT="$fixture/checkout"
mkdir -p "$ROOT/scripts/lib" "$ROOT/tests/fuzz/cargo/corpus/example" "$ROOT/tests/fuzz/cargo/regressions/example"
cp "$HERE/audit-directory.sh" "$ROOT/scripts/lib/audit-directory.sh"
git -C "$ROOT" init --quiet
printf public-seed > "$ROOT/tests/fuzz/cargo/corpus/example/seed"
printf public-regression > "$ROOT/tests/fuzz/cargo/regressions/example/seed"
git -C "$ROOT" add tests/fuzz/cargo/corpus/example/seed tests/fuzz/cargo/regressions/example/seed
printf unreviewed-input > "$ROOT/tests/fuzz/cargo/corpus/example/untracked"
unset OPENSESAME_AUDIT_DIR
source "$HERE/fuzz-directory.sh"
opensesame_fuzz_corpus example
[[ "$corpus" != "$ROOT/"* && "$(stat -c %a "$corpus")" == 700 ]]
cmp "$ROOT/tests/fuzz/cargo/corpus/example/seed" "$corpus/tests/fuzz/cargo/corpus/example/seed"
cmp "$ROOT/tests/fuzz/cargo/regressions/example/seed" "$corpus/tests/fuzz/cargo/regressions/example/seed"
[[ ! -e "$corpus/tests/fuzz/cargo/corpus/example/untracked" ]]
printf private-growth > "$corpus/growth"
[[ ! -e "$ROOT/tests/fuzz/cargo/corpus/example/growth" && ! -e "$ROOT/tests/fuzz/cargo/artifacts" ]]
if opensesame_fuzz_corpus ../escape; then exit 1; fi
for gate in fuzz-pr-gate.sh fuzz-batch.sh jazzer-gate.sh; do
  bash -n "$HERE/../fuzz/$gate"
done
for gate in fuzz-pr-gate.sh fuzz-batch.sh; do
  # CORPUS belongs to cargo-fuzz before '--', or it adds its writable default.
  grep -F -- 'fuzz run "$target" --fuzz-dir tests/fuzz/cargo "$corpus" --' "$HERE/../fuzz/$gate" >/dev/null
done
printf 'fuzz-directory contracts passed; private fixtures retained at %s\n' "$fixture"
