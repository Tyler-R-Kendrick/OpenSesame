#!/usr/bin/env bash
# The servers verify:live-join runs that npm does not carry (ADR 0150 §6).
#
#   nats-server — the mTLS fixture pin (scripts/mtls/mtls-fixtures.sh,
#                 sha256-checked GitHub release).
#   ntfy        — built from its upstream source at a pinned version through
#                 the Go module proxy, whose zip hash sum.golang.org checks.
#                 Its web app and docs are not needed and are stubbed.
#   live-turn   — the TURN server for the relayed walks (scripts/test/live-turn,
#                 pion/turn v4.1.4 pinned in go.mod, checksums in go.sum): UDP,
#                 TCP and TLS on one loopback address, with per-transport
#                 counters for every relay transport.
#
# Output: .cache/mtls-fixtures/nats-server-*/nats-server and
#         .cache/live-fixtures/bin/{ntfy,live-turn}. Fails, never skips.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NTFY_VERSION="2.11.0"
OUT="${ROOT}/.cache/live-fixtures"

bash "${ROOT}/scripts/mtls/mtls-fixtures.sh" fetch nats-server

command -v go >/dev/null || { echo "live-fixtures: go is required to build ntfy and live-turn" >&2; exit 1; }
mkdir -p "${OUT}/bin"

build_ntfy() {
  if [[ -x "${OUT}/bin/ntfy" ]] && "${OUT}/bin/ntfy" --help >/dev/null 2>&1; then
    echo "live-fixtures: ntfy ${NTFY_VERSION} present"
    return
  fi
  local dir
  dir="$(go mod download -json "heckel.io/ntfy/v2@v${NTFY_VERSION}" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["Dir"])')"
  rm -rf "${OUT}/src"
  cp -r "${dir}" "${OUT}/src"
  chmod -R u+w "${OUT}/src"
  for embed in site docs; do
    mkdir -p "${OUT}/src/server/${embed}"
    [[ -f "${OUT}/src/server/${embed}/index.html" ]] ||
      echo '<!doctype html><title>ntfy</title>' > "${OUT}/src/server/${embed}/index.html"
  done
  (cd "${OUT}/src" &&
    CGO_ENABLED=1 go build -tags sqlite_omit_load_extension,osusergo,netgo \
      -o "${OUT}/bin/ntfy" .)
  echo "live-fixtures: built ntfy ${NTFY_VERSION} at ${OUT}/bin/ntfy"
}

# Rebuilt whenever a source, go.mod or go.sum is newer than the binary. The
# module proxy's zips are checked against go.sum, and go.sum against
# sum.golang.org, so a changed dependency fails the build rather than slipping in.
build_turn() {
  local src="${ROOT}/scripts/test/live-turn" bin="${OUT}/bin/live-turn"
  if [[ -x "${bin}" && -z "$(find "${src}" -type f \( -name '*.go' -o -name go.mod -o -name go.sum \) -newer "${bin}")" ]]; then
    echo "live-fixtures: live-turn present"
    return
  fi
  (cd "${src}" && CGO_ENABLED=0 GOFLAGS=-mod=readonly go build -trimpath -o "${bin}" .)
  echo "live-fixtures: built live-turn at ${bin}"
}

build_ntfy
build_turn
