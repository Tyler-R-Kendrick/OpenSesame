#!/usr/bin/env bash
# Bitwarden parity oracle (ADR 0141): the official Bitwarden CLI, pinned, is
# pointed at the bitwarden-compat surface over HTTPS and must behave as it does
# against Bitwarden's own server. Runs the deterministic protocol suite and the
# `#[ignore]`d oracle suites together. Fails, never skips, when `bw` is absent.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# The client release the surface was validated against; bump deliberately,
# together with COMPATIBLE_SERVER_VERSION in crates/bitwarden-server.
BW_VERSION="${OPENSESAME_BW_CLI_VERSION:-2026.9.0}"
CACHE="${ROOT}/.cache/bitwarden-oracle/${BW_VERSION}"

if [[ -z "${OPENSESAME_BW_CLI:-}" ]]; then
  if [[ ! -x "${CACHE}/node_modules/.bin/bw" ]]; then
    mkdir -p "${CACHE}"
    printf '{"private":true}\n' >"${CACHE}/package.json"
    # No lifecycle scripts: the CLI ships prebuilt, and nothing it installs
    # gets to run code at install time.
    npm install --prefix "${CACHE}" --no-audit --no-fund --ignore-scripts \
      "@bitwarden/cli@${BW_VERSION}"
  fi
  export OPENSESAME_BW_CLI="${CACHE}/node_modules/.bin/bw"
fi

installed="$(BITWARDENCLI_APPDATA_DIR="$(mktemp -d)" NODE_NO_WARNINGS=1 "${OPENSESAME_BW_CLI}" --version)"
echo "bitwarden oracle: bw ${installed} (${OPENSESAME_BW_CLI})"
if [[ "${installed}" != "${BW_VERSION}" ]]; then
  echo "bitwarden oracle: expected bw ${BW_VERSION}, found ${installed}" >&2
  exit 1
fi

cargo +1.88.0 test -p opensesame-bitwarden-server --tests -- --include-ignored
