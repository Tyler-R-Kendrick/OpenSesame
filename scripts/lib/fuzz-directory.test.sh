#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
fixture="$(mktemp -d /tmp/opensesame-fuzz-test.XXXXXXXX)"
ROOT="$fixture/checkout"
mkdir -p "$ROOT/scripts/lib" "$ROOT/fuzz/corpus/example" "$ROOT/fuzz/regressions/example"
cp "$HERE/audit-directory.sh" "$ROOT/scripts/lib/audit-directory.sh"
git -C "$ROOT" init --quiet
printf public-seed > "$ROOT/fuzz/corpus/example/seed"
printf public-regression > "$ROOT/fuzz/regressions/example/seed"
git -C "$ROOT" add fuzz/corpus/example/seed fuzz/regressions/example/seed
printf unreviewed-input > "$ROOT/fuzz/corpus/example/untracked"
unset OPENSESAME_AUDIT_DIR
source "$HERE/fuzz-directory.sh"
opensesame_fuzz_corpus example
[[ "$corpus" != "$ROOT/"* && "$(stat -c %a "$corpus")" == 700 ]]
cmp "$ROOT/fuzz/corpus/example/seed" "$corpus/fuzz/corpus/example/seed"
cmp "$ROOT/fuzz/regressions/example/seed" "$corpus/fuzz/regressions/example/seed"
[[ ! -e "$corpus/fuzz/corpus/example/untracked" ]]
printf private-growth > "$corpus/growth"
[[ ! -e "$ROOT/fuzz/corpus/example/growth" && ! -e "$ROOT/fuzz/artifacts" ]]
if opensesame_fuzz_corpus ../escape; then exit 1; fi
for gate in fuzz-pr-gate.sh fuzz-batch.sh jazzer-gate.sh; do
  bash -n "$HERE/../$gate"
done
for gate in fuzz-pr-gate.sh fuzz-batch.sh; do
  # CORPUS belongs to cargo-fuzz before '--', or it adds its writable default.
  grep -F -- 'fuzz run "$target" --fuzz-dir fuzz "$corpus" --' "$HERE/../$gate" >/dev/null
done
printf 'fuzz-directory contracts passed; private fixtures retained at %s\n' "$fixture"
