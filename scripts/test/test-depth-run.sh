#!/usr/bin/env bash
# Each family executes in its own hosted runner; reports never reuse old paths.
set -euo pipefail
family="${1:?test-depth family required}"
root="$(git rev-parse --show-toplevel)"
cd "$root"
: "${TEST_DEPTH_EVIDENCE:?private evidence directory required}"
mkdir -p "$TEST_DEPTH_EVIDENCE/commands"
export OPENSESAME_AUDIT_DIR="$TEST_DEPTH_EVIDENCE/audit"
mkdir -m 700 "$OPENSESAME_AUDIT_DIR"
fail=0

run_gate() {
  local name="$1" status log_status
  local -a statuses
  shift
  printf '%s\n' 'running' > "$TEST_DEPTH_EVIDENCE/commands/$name.status"
  set +e
  "$@" 2>&1 | tee "$TEST_DEPTH_EVIDENCE/commands/$name.log"
  statuses=("${PIPESTATUS[@]}")
  status=${statuses[0]}
  log_status=${statuses[1]}
  set -e
  printf '%s\n' "$status" > "$TEST_DEPTH_EVIDENCE/commands/$name.exit"
  printf '%s\n' "$log_status" > "$TEST_DEPTH_EVIDENCE/commands/$name.log.exit"
  printf '%s\n' 'completed' > "$TEST_DEPTH_EVIDENCE/commands/$name.status"
  if [[ "$status" -ne 0 || "$log_status" -ne 0 ]]; then fail=1; fi
}

case "$family" in
  verify) run_gate verify pnpm verify ;;
  coverage-ts) run_gate coverage-ts pnpm test:coverage:ts ;;
  coverage-rust) run_gate coverage-rust pnpm test:coverage:rust ;;
  scans)
    for gate in cve-lite osv ast-grep gitleaks semgrep cargo-audit; do
      run_gate "$gate" pnpm "audit:$gate"
    done
    ;;
  mutation-ts)
    run_gate mutation-ts pnpm test:mutation:ts
    run_gate mutation-duress pnpm test:mutation:duress
    ;;
  mutation-rust)
    mkdir -p artifacts/mutation
    run_gate mutation-rust pnpm test:mutation:rust
    ;;
  fuzz-ts) run_gate fuzz-ts pnpm test:fuzz ;;
  fuzz-rust) run_gate fuzz-rust pnpm audit:fuzz ;;
  feature-mutation)
    run_gate feature-mutation pnpm exec stryker run tools/mutation/extension-security-feature.config.json
    run_gate feature-mutation-execution node scripts/lib/mutation-execution.mjs artifacts/mutation/extension-security-feature.json
    ;;
  feature-extension)
    run_gate feature-extension pnpm exec stryker run tools/mutation/extension-security-feature-genuine.config.json
    run_gate feature-extension-execution node scripts/lib/mutation-execution.mjs artifacts/mutation/extension-security-feature-genuine.json
    ;;
  feature-fuzz) run_gate feature-fuzz bash scripts/fuzz/jazzer-credential-gate.sh ;;
  *) echo "Unknown test-depth family: $family" >&2; exit 2 ;;
esac
printf '%s\n' "$fail" > "$TEST_DEPTH_EVIDENCE/family.exit"
exit "$fail"
