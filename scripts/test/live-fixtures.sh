#!/usr/bin/env bash
# The servers verify:live-join runs that npm does not carry (ADR 0148 §6).
#
#   nats-server — the mTLS fixture pin (scripts/mtls/mtls-fixtures.sh,
#                 sha256-checked GitHub release).
#   ntfy        — built from its upstream source at a pinned version through
#                 the Go module proxy, whose zip hash sum.golang.org checks.
#                 Its web app and docs are not needed and are stubbed.
#
# Output: .cache/mtls-fixtures/nats-server-*/nats-server and
#         .cache/live-fixtures/bin/ntfy. Fails, never skips.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NTFY_VERSION="2.11.0"
OUT="${ROOT}/.cache/live-fixtures"

bash "${ROOT}/scripts/mtls/mtls-fixtures.sh" fetch nats-server

if [[ -x "${OUT}/bin/ntfy" ]] && "${OUT}/bin/ntfy" --help >/dev/null 2>&1; then
  echo "live-fixtures: ntfy ${NTFY_VERSION} present"
  exit 0
fi
command -v go >/dev/null || { echo "live-fixtures: go is required to build ntfy" >&2; exit 1; }
mkdir -p "${OUT}/bin"
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
