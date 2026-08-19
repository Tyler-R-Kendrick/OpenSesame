#!/usr/bin/env bash
# Line/branch coverage for the TypeScript planes.
#
# Not part of `pnpm verify`: coverage is a number to look at, not a gate to
# pass. A threshold tempts tests written to move it rather than to catch
# anything, and this repo's PACT suites are judged on what they refuse, not on
# how many lines they touch. The report exists so "is this well covered?" has
# an answer instead of an opinion.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Vitest does its own transform, and a loader injected through NODE_OPTIONS
# fights it — some Node builds refuse `--import tsx` outright and the runner
# dies before a single test is collected. Drop it for this run rather than
# reporting zero coverage as though nothing were wrong.
unset NODE_OPTIONS

# Packages whose failure modes are security-relevant. Add to this list rather
# than sweeping the workspace: a number averaged over fixtures and demo apps
# tells you nothing about the code that matters.
PACKAGES=(
  packages/os-domain
  packages/policy
  packages/audit
  packages/claims
  packages/device-auth
  packages/ceremony-kit
  packages/contracts
  packages/database
)

FILTER="${1:-}"
status=0

printf '%-28s %-24s %s\n' "PACKAGE" "STATEMENTS" "BRANCHES"
printf '%-28s %-24s %s\n' "----------------------------" "------------------------" "------------------------"

for pkg in "${PACKAGES[@]}"; do
  if [ -n "$FILTER" ] && [[ "$pkg" != *"$FILTER"* ]]; then continue; fi
  if [ ! -d "$pkg" ]; then
    printf '%-28s %s\n' "$pkg" "missing"
    status=1
    continue
  fi
  out="$(cd "$pkg" && npx vitest run \
    --coverage.enabled \
    --coverage.provider=v8 \
    --coverage.reporter=text-summary 2>&1 || true)"
  stmts="$(printf '%s' "$out" | grep -E '^Statements' | sed 's/Statements *: *//' | tr -d '\n')"
  branches="$(printf '%s' "$out" | grep -E '^Branches' | sed 's/Branches *: *//' | tr -d '\n')"
  if [ -z "$stmts" ]; then
    printf '%-28s %s\n' "$pkg" "no coverage produced"
    status=1
    continue
  fi
  printf '%-28s %-24s %s\n' "$pkg" "$stmts" "$branches"
done

exit "$status"
