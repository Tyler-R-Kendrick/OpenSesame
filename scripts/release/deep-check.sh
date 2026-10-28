#!/usr/bin/env bash
# These are source/test builds. They never replace the promoted production bytes.
set -euo pipefail
check="${1:?required check name}"
case "$check" in
  mutation-typescript|mutation-duress|mutation-rust|dependencies|sast|secrets|kani|miri|shuttle|fuzz-rust|fuzz-typescript) ;;
  *) echo "Unknown release check: $check" >&2; exit 1 ;;
esac
test "$(git rev-parse HEAD)" = "${SOURCE_SHA:?}"
report_root="${RUNNER_TEMP:?}/release-checks/$check"
mkdir -m 700 -p "$report_root"
rm -f "$report_root/passed.txt" "$report_root/completed-at.txt"
export OPENSESAME_AUDIT_DIR="$report_root"
exec > >(tee "$report_root/results.log") 2>&1
printf '%s\n' "$SOURCE_SHA" > "$report_root/source-sha.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$report_root/started-at.txt"

case "$check" in
  mutation-typescript)
    rm -f artifacts/mutation/typescript.json
    pnpm test:mutation:ts
    node scripts/release/deep-mutation-report.mjs typescript artifacts/mutation/typescript.json tools/mutation/stryker.config.json
    ;;
  mutation-duress)
    rm -f artifacts/mutation/duress-unlock.json
    pnpm test:mutation:duress
    node scripts/release/deep-mutation-report.mjs typescript artifacts/mutation/duress-unlock.json tools/mutation/stryker.duress.config.json
    ;;
  mutation-rust)
    pnpm test:mutation:rust
    node scripts/release/deep-mutation-report.mjs artifacts/mutation/rust
    ;;
  dependencies)
    pnpm audit:osv
    pnpm audit:cargo-audit
    cargo +1.88.0 deny check
    pnpm exec vitest run scripts/lib/dependency-compatibility.test.mjs
    ;;
  sast)
    pnpm audit:ast-grep
    pnpm audit:semgrep
    ;;
  secrets)
    test "${OPENSESAME_GITLEAKS_HISTORY_FAIL:-0}" = 1
    pnpm audit:gitleaks
    ;;
  kani) pnpm audit:kani ;;
  miri) pnpm audit:miri ;;
  shuttle) pnpm audit:shuttle ;;
  fuzz-rust)
    test -z "${FUZZ_BATCH_BUDGET:-}"
    pnpm audit:fuzz:batch
    ;;
  fuzz-typescript)
    test "${JAZZER_ALLOW_FALLBACK:-0}" = 0
    pnpm test:fuzz:batch
    ;;
esac
git diff --exit-code
git diff --cached --exit-code
date -u +%Y-%m-%dT%H:%M:%SZ > "$report_root/completed-at.txt"
printf '%s\n' "$check" > "$report_root/passed.txt"
