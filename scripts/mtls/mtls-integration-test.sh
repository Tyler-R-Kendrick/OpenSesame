#!/usr/bin/env bash
# mtls-integration-test.sh — real-protocol mTLS suite (`pnpm test:mtls:integration`).
#
# Fetches the pinned fixtures (scripts/mtls/mtls-fixtures.sh), proves each binary
# starts, brings up a loopback JetStream nats-server and an OpenBao dev server
# on free ports inside a self-cleaning tempdir, then runs every `#[ignore]`d
# mTLS suite with OPENSESAME_MTLS_FIXTURES=1. Every step is bounded by
# `timeout` and by the manifest runner's own process-group kill; every spawned
# process dies with this script (trap EXIT); the tempdir is removed.
#
# Fail-closed rules (AT-EVIDENCE-NORUN): a fixture that cannot be fetched,
# verified or started is a FAILED step; a required suite that selects 0 tests
# or leaves every test ignored is FAILED; a crate listed in
# scripts/mtls/mtls-required-packages.txt that is missing is FAILED. No verification
# step is `|| true` (only the EXIT trap's kills are). Run it twice for AT-EVIDENCE-REPEAT: each run has its own run
# dir, tempdir and ports and shares nothing with the previous one.
#
# Usage: bash scripts/mtls/mtls-integration-test.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT}"
export NODE_OPTIONS="--max-old-space-size=8192"
export CARGO_TERM_COLOR=never
MANIFEST="node ${ROOT}/scripts/lib/mtls-manifest.mjs"
FIXTURES="${ROOT}/scripts/mtls/mtls-fixtures.sh"
REQ_FILE="${ROOT}/scripts/mtls/mtls-required-packages.txt"
RUN_DIR="${OPENSESAME_MTLS_RUN_DIR:-artifacts/mtls/runs/integration-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
STEP_TIMEOUT="${OPENSESAME_MTLS_STEP_TIMEOUT:-1800}"

export OPENSESAME_MTLS_FIXTURES=1
export OPENSESAME_MTLS_FIXTURE_DIR="${OPENSESAME_MTLS_FIXTURE_DIR:-${ROOT}/.cache/mtls-fixtures}"
export PLAYWRIGHT_CHROMIUM="${PLAYWRIGHT_CHROMIUM:-/opt/pw-browsers/chromium}"

# ---- self-cleaning workspace + kill-on-exit ---------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-mtls-XXXXXX")"
export TMPDIR="${WORK}/tmp"; mkdir -p "${TMPDIR}"
PIDS=()
cleanup() {
  local rc=$?
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid}" ]] || continue
    if kill -0 "${pid}" 2>/dev/null; then kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true; fi
  done
  sleep 0.5
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid}" ]] || continue
    kill -KILL -- "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
    wait "${pid}" 2>/dev/null || true
  done
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM

step() { ${MANIFEST} run-step --run "${RUN_DIR}" "$@"; }
# Steps are spawned by the manifest runner (not this shell), so the bound is
# spelled out as a real `timeout` program invocation, never a shell function.
BOUNDED=(timeout --foreground -k 15 "${STEP_TIMEOUT}")
is_required() { grep -vE '^\s*(#|$)' "${REQ_FILE}" | tr -d ' \t\r' | grep -qx -- "$1"; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
tcp_ready() { python3 -c 'import socket,sys;s=socket.socket();s.settimeout(0.3)
try: s.connect(("127.0.0.1",int(sys.argv[1]))); sys.exit(0)
except Exception: sys.exit(1)' "$1"; }

${MANIFEST} begin --run "${RUN_DIR}" --suite integration >/dev/null
echo "==> mtls-integration: run dir ${RUN_DIR}, work ${WORK}"

# ---- 1. fixtures: fetch + verify + every binary must start -------------------
step --id fixtures-fetch --claim OPS-REPRODUCE --scenarios AT-EVIDENCE-NORUN --required true --timeout 900 \
  --profile fixtures --target "${OPENSESAME_MTLS_FIXTURE_DIR}" --paths scripts/mtls/mtls-fixtures.sh \
  --expected "every pinned archive downloads (or is cached) and matches its sha256; extracted binaries match their pins" -- \
  bash -c "bash '${FIXTURES}' fetch all && bash '${FIXTURES}' verify"

declare -A BIN=()
for t in nats-server nats-server-2.10 openbao spire-server spire-agent caddy; do
  if p="$(bash "${FIXTURES}" path "${t}" 2>/dev/null)"; then BIN[${t}]="${p}"; else BIN[${t}]=""; fi
done
export OPENSESAME_MTLS_BIN_NATS_SERVER="${BIN[nats-server]}"
export OPENSESAME_MTLS_BIN_NATS_SERVER_210="${BIN[nats-server-2.10]}"
export OPENSESAME_MTLS_BIN_BAO="${BIN[openbao]}"
export OPENSESAME_MTLS_BIN_SPIRE_SERVER="${BIN[spire-server]}"
export OPENSESAME_MTLS_BIN_SPIRE_AGENT="${BIN[spire-agent]}"
export OPENSESAME_MTLS_BIN_CADDY="${BIN[caddy]}"

start_check() { # tool version-args...
  local t="$1"; shift
  local b="${BIN[${t}]}"
  if [[ -z "${b}" || ! -x "${b}" ]]; then
    step --id "fixture-start-${t}" --claim OPS-REPRODUCE --scenarios AT-EVIDENCE-NORUN --required true \
      --expected "${t} binary present and starts" --observed-fail "binary missing" -- bash -c "echo '${t}: binary missing'; exit 1"
    return
  fi
  step --id "fixture-start-${t}" --claim OPS-REPRODUCE --scenarios AT-EVIDENCE-NORUN --required true --runner marker --timeout 60 \
    --profile fixtures --target "${b}" --expected "${t} $(bash "${FIXTURES}" version "${t}") starts and reports its version" -- \
    bash -c "out=\$(timeout 30 '${b}' $* 2>&1) && echo \"\$out\" && echo MTLS_TESTS passed=1 failed=0"
}
start_check nats-server --version
start_check nats-server-2.10 --version
start_check openbao version
start_check spire-server --version
start_check spire-agent --version
start_check caddy version

# ---- 2. loopback services on free ports (for the existing live suites) ------
NATS_PORT="$(free_port)"; BAO_PORT="$(free_port)"
mkdir -p "${WORK}/nats" "${WORK}/bao"
if [[ -x "${BIN[nats-server]}" ]]; then
  setsid "${BIN[nats-server]}" -js -a 127.0.0.1 -p "${NATS_PORT}" -sd "${WORK}/nats" >"${WORK}/nats.log" 2>&1 &
  PIDS+=($!)
fi
if [[ -x "${BIN[openbao]}" ]]; then
  BAO_ROOT_TOKEN="$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
  setsid env BAO_DEV_ROOT_TOKEN_ID="${BAO_ROOT_TOKEN}" "${BIN[openbao]}" server -dev \
    -dev-listen-address="127.0.0.1:${BAO_PORT}" >"${WORK}/bao.log" 2>&1 &
  PIDS+=($!)
fi
ready=1
for _ in $(seq 1 60); do
  if tcp_ready "${NATS_PORT}" && curl -sf "http://127.0.0.1:${BAO_PORT}/v1/sys/health" >/dev/null 2>&1; then ready=0; break; fi
  sleep 0.25
done
if [[ ${ready} -eq 0 ]]; then
  step --id services-ready --claim OPS-REPRODUCE --scenarios AT-EVIDENCE-REPEAT --required true --runner marker \
    --profile "nats(js)+openbao(dev) loopback" --target "127.0.0.1:${NATS_PORT}, 127.0.0.1:${BAO_PORT}" \
    --expected "fixture services accept connections on freshly allocated loopback ports and OpenBao takes a seed write" -- \
    env BAO_ADDR="http://127.0.0.1:${BAO_PORT}" BAO_TOKEN="${BAO_ROOT_TOKEN:-}" \
    bash -c "'${BIN[openbao]}' kv put -mount=secret github/acme token=never-to-agent >/dev/null && echo 'nats :${NATS_PORT} openbao :${BAO_PORT} ready' && echo MTLS_TESTS passed=2 failed=0"
  export NATS_URL="nats://127.0.0.1:${NATS_PORT}"
  export OPENSESAME_OPENBAO_URL="http://127.0.0.1:${BAO_PORT}"
  export OPENSESAME_OPENBAO_TOKEN="${BAO_ROOT_TOKEN:-}"
  export BAO_ADDR="${OPENSESAME_OPENBAO_URL}" BAO_TOKEN="${OPENSESAME_OPENBAO_TOKEN}"
else
  step --id services-ready --claim OPS-REPRODUCE --scenarios AT-EVIDENCE-REPEAT --required true \
    --expected "fixture services accept connections" --observed-fail "nats/openbao did not become ready" -- \
    bash -c "tail -20 '${WORK}/nats.log' '${WORK}/bao.log' 2>/dev/null; exit 1"
fi

# ---- 3. ignored Rust suites --------------------------------------------------
PRESENT="$(cargo +1.88.0 metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import json,sys; print("\n".join(sorted(p["name"] for p in json.load(sys.stdin)["packages"])))')"
rust_step() { # id crate required-default profile features... -- filter-args...
  local id="$1" crate="$2" req="$3" profile="$4"; shift 4
  is_required "${crate}" && req=true
  if ! grep -qx -- "${crate}" <<<"${PRESENT}"; then
    step --id "${id}" --claim "${crate}" --runner cargo --required "${req}" --skip "crate ${crate} not present in cargo metadata"
    return
  fi
  step --id "${id}" --claim "${crate}" --runner cargo --required "${req}" --timeout $((STEP_TIMEOUT + 60)) \
    --profile "${profile}" --target "cargo test -p ${crate} -- --ignored" \
    --expected "real-protocol tests of ${crate} run against the pinned fixtures and pass (0 selected = failure)" -- \
    "${BOUNDED[@]}" cargo +1.88.0 test -p "${crate}" "$@"
}
rust_step it-spiffe-source opensesame-spiffe-source true "spiffe workload api (spire ${BIN[spire-agent]:+$(bash "${FIXTURES}" version spire-agent)})" --all-features -- --ignored
rust_step it-ingress-evidence opensesame-ingress-evidence true "trusted_ingress (caddy)" --all-features -- --ignored
# The live NATS suites are gated on `live-tests`, not on `jetstream`: with only
# `jetstream` the modules are not compiled at all, so `--ignored` selected
# nothing and the step reported an empty selection.
rust_step it-task-bus-live opensesame-task-bus true "nats client transport, roles, topology and callout (live-tests)" --features live-tests -- --ignored
rust_step it-nats-callout opensesame-nats-callout true "nats auth callout bridge" --all-features -- --ignored
rust_step it-provider-openbao opensesame-provider-openbao true "upstream connector (openbao cert auth)" -- --ignored
# The gateway binary's only `#[ignore]`d test is the live task-bus operator
# route, and it is not named "transport" — filtering on that word selected
# nothing. The Host secure listener's real-handshake behaviour is not covered
# by a gateway-bin test at all; it is covered by opensesame-transport-security's
# own listener tests and by the interop crate below, and the evidence document
# says so rather than implying a gateway test that does not exist.
if [[ -d crates/gateway/src/transport ]]; then
  rust_step it-gateway-live opensesame-gateway true "live task-bus operator route against the pinned nats-server" --lib -- --ignored
else
  step --id it-gateway-live --claim opensesame-gateway --runner cargo --required false --skip "crates/gateway/src/transport not present"
fi
rust_step it-mtls-interop opensesame-mtls-interop false "interop (openssl/curl oracles)" -- --ignored

# ---- 4. Identity real-TLS + browser -----------------------------------------
if [[ -d apps/control-plane/src/transport ]]; then
  req=false; is_required ts:control-plane-transport-live && req=true
  step --id it-identity-tls --claim ts:control-plane-transport-live --runner vitest --required "${req}" --timeout $((STEP_TIMEOUT + 60)) \
    --profile "identity receiver (node tls, mtls_required)" --target vitest --paths apps/control-plane/src/transport \
    --expected "Identity accepts a bound client certificate and rejects a missing/unbound one over real TLS" -- \
    "${BOUNDED[@]}" pnpm --filter @opensesame/control-plane exec vitest run src/transport
else
  step --id it-identity-tls --claim ts:control-plane-transport-live --runner vitest --required false --skip "apps/control-plane/src/transport not present"
fi
step --id it-browser --claim AT-BROWSER-UX --scenarios AT-BROWSER-EXTERNAL,AT-BROWSER-UX,AT-STATIC-EMPTY --runner marker --required true --timeout $((STEP_TIMEOUT + 60)) \
  --profile "browser (chromium)" --target "${PLAYWRIGHT_CHROMIUM}" --paths scripts/mtls/mtls-browser-test.mjs \
  --expected "browser scenarios that exist run; the rest are not_executed, never passed" -- \
  "${BOUNDED[@]}" node scripts/mtls/mtls-browser-test.mjs

${MANIFEST} finish --run "${RUN_DIR}"
