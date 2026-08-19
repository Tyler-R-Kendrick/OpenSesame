#!/usr/bin/env bash
# NATS dogfood verification: unit + HTTP + fuzz oracles + live JetStream.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NATS_PID=""
NATS_PORT=""
STARTED_NATS=0

cleanup() {
  if [[ -n "${NATS_PID}" ]] && kill -0 "${NATS_PID}" 2>/dev/null; then
    kill "${NATS_PID}" 2>/dev/null || true
    wait "${NATS_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

find_nats_server() {
  if command -v nats-server >/dev/null 2>&1; then
    command -v nats-server
    return 0
  fi
  if [[ -x "${HOME}/.local/bin/nats-server" ]]; then
    echo "${HOME}/.local/bin/nats-server"
    return 0
  fi
  local cache="${ROOT}/.cache/nats-server"
  if [[ -x "${cache}/nats-server" ]]; then
    echo "${cache}/nats-server"
    return 0
  fi
  local arch
  arch="$(uname -m)"
  local asset=""
  case "${arch}" in
    aarch64|arm64) asset="nats-server-v2.10.18-linux-arm64" ;;
    x86_64|amd64) asset="nats-server-v2.10.18-linux-amd64" ;;
    *) return 1 ;;
  esac
  mkdir -p "${cache}"
  local url="https://github.com/nats-io/nats-server/releases/download/v2.10.18/${asset}.tar.gz"
  echo "==> nats-dogfood: downloading ${asset}" >&2
  curl -fsSL "${url}" | tar -xz -C "${cache}" --strip-components=1 "${asset}/nats-server"
  chmod +x "${cache}/nats-server"
  echo "${cache}/nats-server"
}

pick_free_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

ensure_live_nats() {
  if [[ -n "${NATS_URL:-}" ]]; then
    echo "==> nats-dogfood: using existing NATS_URL=${NATS_URL}"
    return 0
  fi
  local bin
  if ! bin="$(find_nats_server)"; then
    echo "==> nats-dogfood: FATAL — no nats-server and NATS_URL unset" >&2
    echo "    Install nats-server or set NATS_URL / run deploy/compose NATS" >&2
    exit 1
  fi
  NATS_PORT="$(pick_free_port)"
  local store
  store="$(mktemp -d "${TMPDIR:-/tmp}/opensesame-nats-XXXXXX")"
  echo "==> nats-dogfood: starting JetStream nats-server on 127.0.0.1:${NATS_PORT}"
  "${bin}" -js -a 127.0.0.1 -p "${NATS_PORT}" -sd "${store}" >/dev/null 2>&1 &
  NATS_PID=$!
  STARTED_NATS=1
  export NATS_URL="nats://127.0.0.1:${NATS_PORT}"
  for _ in $(seq 1 40); do
    if "${bin}" --help >/dev/null 2>&1 && python3 - <<PY
import socket, sys
s=socket.socket(); s.settimeout(0.2)
try:
  s.connect(("127.0.0.1", int("${NATS_PORT}")))
  sys.exit(0)
except Exception:
  sys.exit(1)
finally:
  s.close()
PY
    then
      echo "==> nats-dogfood: live NATS_URL=${NATS_URL}"
      return 0
    fi
    sleep 0.1
  done
  echo "==> nats-dogfood: FATAL — nats-server did not become ready" >&2
  exit 1
}

echo "==> nats-dogfood: Rust unit + HTTP tests"
cargo +1.88.0 test -p opensesame-task-bus --all-targets
cargo +1.88.0 test -p opensesame-authz --lib callout
cargo +1.88.0 test -p opensesame-connection-broker --lib github_webhook_hmac
cargo +1.88.0 test -p opensesame-storage --lib host_kv
cargo +1.88.0 test -p opensesame-gateway --bin opensesame-gateway
cargo +1.88.0 test --manifest-path fuzz/Cargo.toml --lib oracle_smoke

echo "==> nats-dogfood: TypeScript contracts + pages + worker"
pnpm --filter @opensesame/contracts test
pnpm --filter @opensesame/pages exec vitest run \
  src/lib/taskbus.test.ts \
  src/lib/taskbus-panel.test.ts \
  src/sections/settings/TaskBusPanel.test.tsx
pnpm --filter @opensesame/worker test

if command -v cargo-fuzz >/dev/null 2>&1; then
  echo "==> nats-dogfood: libFuzzer short pass (dogfood targets)"
  for target in github_webhook_hmac nats_callout_eval taskbus_url xkeys_envelope; do
    mkdir -p "fuzz/corpus/$target"
    cargo +nightly fuzz run "$target" --fuzz-dir fuzz -- \
      -max_total_time=10 -timeout=5 "fuzz/corpus/$target" || exit 1
  done
else
  echo "==> nats-dogfood: skipping libFuzzer (cargo-fuzz not installed)"
fi

ensure_live_nats

echo "==> nats-dogfood: live JetStream round-trip (NATS_URL=${NATS_URL})"
cargo +1.88.0 test -p opensesame-task-bus --features jetstream -- --ignored --nocapture

echo "==> nats-dogfood: live Host operator TaskBus against JetStream"
cargo +1.88.0 test -p opensesame-gateway --bin opensesame-gateway live_nats -- --ignored --nocapture

echo "==> nats-dogfood: Jazzer/local contract fuzz (taskbus)"
FUZZ_SECONDS="${FUZZ_SECONDS:-3}" pnpm --filter @opensesame/fuzz exec tsx src/run.ts taskbus

echo "nats-dogfood: OK"
