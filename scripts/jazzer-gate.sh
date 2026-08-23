#!/usr/bin/env bash
# TypeScript fuzz pass. Requires native Jazzer.js; when the addon is not
# loadable the gate fails closed. Set JAZZER_ALLOW_FALLBACK=1 to explicitly
# opt in to the local uncoverage-guided runner (reported as DEGRADED, never
# CLEAN).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/packages/fuzz"

SECONDS_PER_TARGET="${FUZZ_SECONDS:-30}"

if [[ ! -f package.json ]]; then
  echo "jazzer-gate: packages/fuzz is missing" >&2
  exit 1
fi

if command -v jazzer >/dev/null 2>&1 && node -e 'import("@jazzer.js/core")' >/dev/null 2>&1; then
  echo "==> jazzer-gate: native Jazzer.js (${SECONDS_PER_TARGET}s/target)"
  fail=0
  mkdir -p artifacts
  for f in src/*.ts; do
    base="$(basename "$f")"
    case "$base" in
      oracles.ts|oracles.test.ts|provider.ts|run.ts) continue ;;
    esac
    name="${base%.ts}"
    echo "--> $name"
    if ! FUZZ_SECONDS="$SECONDS_PER_TARGET" jazzer "$f" \
        -max_total_time="$SECONDS_PER_TARGET" \
        -artifact_prefix="$PWD/artifacts/${name}-"; then
      echo "jazzer-gate: FAIL $name" >&2
      fail=1
    fi
  done
  if [[ "$fail" -ne 0 ]]; then
    exit 1
  fi
  echo "jazzer-gate: CLEAN"
  exit 0
fi

if [[ "${JAZZER_ALLOW_FALLBACK:-0}" != "1" ]]; then
  echo "jazzer-gate: native Jazzer.js addon is not loadable." >&2
  echo "  pnpm --filter @opensesame/fuzz install  # rebuild @jazzer.js/core native addon" >&2
  echo "  (or set JAZZER_ALLOW_FALLBACK=1 to run the uncoverage-guided local runner," >&2
  echo "   which reports DEGRADED, never CLEAN)" >&2
  echo "This gate is optional and is not part of pnpm verify." >&2
  exit 1
fi

echo "==> jazzer-gate: local runner (${SECONDS_PER_TARGET}s/target; native Jazzer.js addon not loaded)"
FUZZ_SECONDS="$SECONDS_PER_TARGET" pnpm exec tsx src/run.ts
echo "jazzer-gate: DEGRADED (uncoverage-guided fallback) — not a CLEAN coverage-guided pass"
