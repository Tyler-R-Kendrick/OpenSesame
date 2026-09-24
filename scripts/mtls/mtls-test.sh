#!/usr/bin/env bash
# mtls-test.sh — the fast mTLS suite (`pnpm test:mtls`). No network, no fixtures.
#
# Runs the pure/unit layers of the optional mTLS work and the static-bundle
# boundary check, recording every step in artifacts/mtls/ through
# scripts/lib/mtls-manifest.mjs:
#
#   1. preflight: every crate named in scripts/mtls/mtls-required-packages.txt must
#      exist in `cargo metadata` — a missing required crate is a FAILED step,
#      not a skip (AT-EVIDENCE-NORUN);
#   2. Rust: `cargo +1.88.0 test -p <crate> --all-features` per crate, plus one
#      default-feature run across the present crates;
#   3. TypeScript: @opensesame/os-domain, @opensesame/contracts,
#      @opensesame/oauth-provider (whole suites), @opensesame/ingress-evidence,
#      @opensesame/control-plane `src/transport`, @opensesame/pages transport tests;
#   4. scripts/mtls/mtls-static-imports.mjs (AT-STATIC-IMPORTS).
#
# A required step whose runner reports 0 passed tests is FAILED. Steps for
# suites that do not exist yet are `not_executed` unless the suite is listed as
# required (`ts:<id>` lines in mtls-required-packages.txt).
#
# Usage: bash scripts/mtls/mtls-test.sh [--skip-build]   (--skip-build reuses apps/pages/dist)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
export NODE_OPTIONS="--max-old-space-size=8192"
export CARGO_TERM_COLOR=never
MANIFEST="node ${ROOT}/scripts/lib/mtls-manifest.mjs"
REQ_FILE="${ROOT}/scripts/mtls/mtls-required-packages.txt"
RUN_DIR="${OPENSESAME_MTLS_RUN_DIR:-artifacts/mtls/runs/fast-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

# Crates the fast suite covers (CONTRACT §2). Presence is checked; requirement
# comes from mtls-required-packages.txt.
CRATES=(opensesame-domain opensesame-transport-security opensesame-spiffe-source opensesame-ingress-evidence opensesame-nats-callout)

step() { ${MANIFEST} run-step --run "${RUN_DIR}" "$@"; }

is_required() { # name (crate or ts:<id>)
  grep -vE '^\s*(#|$)' "${REQ_FILE}" | tr -d ' \t\r' | grep -qx -- "$1"
}

${MANIFEST} begin --run "${RUN_DIR}" --suite fast >/dev/null
echo "==> mtls-test: run dir ${RUN_DIR}"

# ---- 1. preflight -----------------------------------------------------------
PRESENT="$(cargo +1.88.0 metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import json,sys; print("\n".join(sorted(p["name"] for p in json.load(sys.stdin)["packages"])))')"
missing_required=()
present_crates=()
for c in "${CRATES[@]}"; do
  if grep -qx -- "${c}" <<<"${PRESENT}"; then present_crates+=("${c}")
  elif is_required "${c}"; then missing_required+=("${c}")
  fi
done
if [[ ${#missing_required[@]} -gt 0 ]]; then
  step --id preflight-packages --claim OPS-RUNNERS --scenarios AT-EVIDENCE-NORUN --required true \
    --expected "every crate in scripts/mtls/mtls-required-packages.txt exists in cargo metadata" \
    --observed-fail "missing required crate(s): ${missing_required[*]}" -- \
    bash -c "echo 'missing required crates: ${missing_required[*]}'; exit 1"
else
  step --id preflight-packages --claim OPS-RUNNERS --scenarios AT-EVIDENCE-NORUN --required true --runner marker \
    --expected "every crate in scripts/mtls/mtls-required-packages.txt exists in cargo metadata" -- \
    bash -c "echo 'present: ${present_crates[*]}'; echo MTLS_TESTS passed=${#present_crates[@]} failed=0"
fi

# ---- 2. Rust ----------------------------------------------------------------
for c in "${CRATES[@]}"; do
  req=false; is_required "${c}" && req=true
  if grep -qx -- "${c}" <<<"${PRESENT}"; then
    step --id "rust-${c}" --claim "${c}" --runner cargo --required "${req}" --timeout 2400 \
      --profile unit --target "cargo test --all-features" --paths "$(cargo +1.88.0 metadata --no-deps --format-version 1 2>/dev/null | python3 -c "import json,sys; print(next(p['manifest_path'] for p in json.load(sys.stdin)['packages'] if p['name']=='${c}').replace('${ROOT}/',''))")" \
      --expected "unit + property tests of ${c} pass with every feature enabled" -- \
      cargo +1.88.0 test -p "${c}" --all-features
  else
    step --id "rust-${c}" --claim "${c}" --runner cargo --required "${req}" --skip "crate not present in cargo metadata"
  fi
done
if [[ ${#present_crates[@]} -gt 0 ]]; then
  args=(); for c in "${present_crates[@]}"; do args+=(-p "${c}"); done
  step --id rust-default-features --claim OPS-RUNNERS --runner cargo --required true --timeout 2400 \
    --profile unit --target "cargo test (default features)" \
    --expected "the same crates pass with default features (no feature-gated code is load-bearing)" -- \
    cargo +1.88.0 test "${args[@]}"
fi

# ---- 3. TypeScript ----------------------------------------------------------
# A few workspace packages publish their main entry through `dist/` rather than
# `src/`, so a TypeScript step that imports one cannot resolve it in a checkout
# that has only been installed. On a developer machine an earlier build hides
# this; on a clean runner every suite reaching `@opensesame/oauth-provider`
# fails at import with "Failed to resolve entry for package". Build them first,
# through turbo so the work is cached and their own dependencies come along.
DIST_PACKAGES=(@opensesame/oauth-provider @opensesame/auth-upstream)
build_args=(); for pkg in "${DIST_PACKAGES[@]}"; do build_args+=(--filter "${pkg}"); done
step --id ts-dist-dependencies --claim OPS-RUNNERS --runner marker --required true --timeout 900 \
  --profile unit --target "turbo run build" \
  --expected "workspace packages whose entry points resolve through dist/ are built before any TypeScript step imports them" -- \
  bash -c 'pnpm exec turbo run build "$@" >&2 && echo "MTLS_TESTS passed='"${#DIST_PACKAGES[@]}"' failed=0"' _ "${build_args[@]}"

ts_step() { # id required-default path-that-must-exist command...
  local id="$1" req="$2" need="$3"; shift 3
  is_required "ts:${id}" && req=true
  if [[ -e "${ROOT}/${need}" ]]; then
    step --id "ts-${id}" --claim "ts:${id}" --runner vitest --required "${req}" --timeout 900 \
      --profile unit --target vitest --paths "${need}" --expected "TypeScript suite ${id} passes with a non-empty selection" -- "$@"
  else
    step --id "ts-${id}" --claim "ts:${id}" --runner vitest --required "${req}" --skip "${need} does not exist"
  fi
}
ts_step os-domain true packages/os-domain/src pnpm --filter @opensesame/os-domain exec vitest run
ts_step contracts true packages/contracts/src pnpm --filter @opensesame/contracts exec vitest run
ts_step oauth-provider true packages/oauth-provider/src pnpm --filter @opensesame/oauth-provider exec vitest run
ts_step ingress-evidence false packages/ingress-evidence/src pnpm --filter @opensesame/ingress-evidence exec vitest run
ts_step control-plane-transport false packages/control-plane/src/transport pnpm --filter @opensesame/control-plane exec vitest run src/transport
ts_step core-transport false packages/app-core/src/lib/transport-status.ts pnpm --filter @opensesame/app-core exec vitest run src/lib/transport
ts_step pages-transport false apps/pages/src/sections/settings/transport pnpm --filter @opensesame/pages exec vitest run src/sections/settings/transport

# ---- 4. static bundle boundary ---------------------------------------------
static_args=(); [[ ${SKIP_BUILD} -eq 1 ]] && static_args+=(--no-build)
step --id static-imports --claim AT-STATIC-IMPORTS --scenarios AT-STATIC-IMPORTS --runner marker --required true --timeout 1500 \
  --profile static --target "apps/pages/dist" --paths scripts/mtls/mtls-static-imports.mjs \
  --expected "no native TLS/fs/net/process/SPIFFE-socket/attestation code in the shipped Pages bundle or its import graph" -- \
  node scripts/mtls/mtls-static-imports.mjs "${static_args[@]}"

${MANIFEST} finish --run "${RUN_DIR}"
