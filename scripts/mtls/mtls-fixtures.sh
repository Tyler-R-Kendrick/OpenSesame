#!/usr/bin/env bash
# mtls-fixtures.sh — pinned, checksum-verified native fixtures for the mTLS suites.
#
# Every binary the `test:mtls:integration` job needs (and nothing the browser
# app needs) is fetched from an upstream GitHub release into
#   ${OPENSESAME_MTLS_FIXTURE_DIR:-<repo>/.cache/mtls-fixtures}/<tool>-<version>/
# and verified against the sha256 pins below BEFORE it is extracted, and again
# (archive + extracted binary) on `verify`. A mismatch is always fatal — there
# is no `|| true` anywhere on this path (AT-EVIDENCE-NORUN).
#
# No sudo, no system paths, no docker, no PATH mutation. Linux only, on
# x86_64 (amd64) and aarch64 (arm64); any other platform exits 3
# (`unsupported`) rather than pretending.
#
# Interface (stable — other swarms' Rust test helpers call it):
#   mtls-fixtures.sh path <tool>      print the absolute binary path, fetching if needed
#   mtls-fixtures.sh version <tool>   print the pinned version
#   mtls-fixtures.sh fetch <tool|all> fetch + verify (idempotent), print the path(s)
#   mtls-fixtures.sh verify [tool|all] re-hash archive and binary; exit 1 on mismatch
#   mtls-fixtures.sh list             tool / version / url / sha256 table (tab separated)
#   mtls-fixtures.sh dir              print the fixture directory
#
# Tools: nats-server (2.11.x), nats-server-2.10 (the dogfood pin, kept
# separately so scripts/test/nats-dogfood-test.sh is unchanged), openbao (bao),
# spire-server, spire-agent, caddy.
#
# Pins (recorded 2026-09-22; each asset was downloaded once and hashed here):
#
#   tool              version  asset URL
#   nats-server       2.11.17  https://github.com/nats-io/nats-server/releases/download/v2.11.17/nats-server-v2.11.17-linux-amd64.tar.gz
#                              archive sha256 ad608dd0ea8bbfa58c40e3b8f58ed67478eec26166ec49c502db8d17589b51b5
#                              cross-checked against upstream SHA256SUMS at the same release (match)
#   nats-server-2.10  2.10.18  https://github.com/nats-io/nats-server/releases/download/v2.10.18/nats-server-v2.10.18-linux-amd64.tar.gz
#                              archive sha256 7760fe7347ba8e8daf4474811cf7fc301713aa8f3d4e0787d3e79a496dd537b2
#                              cross-checked against upstream SHA256SUMS (match)
#   openbao           2.3.2    https://github.com/openbao/openbao/releases/download/v2.3.2/bao_2.3.2_Linux_x86_64.tar.gz
#                              archive sha256 26ddcffecdcbb0a3a48b8713ddda83de3084886d3df13686ffddbb158855bdcf
#                              NOT cross-checked: the release publishes only a cosign `.sig`, no checksum file
#   spire-server /    1.12.6   https://github.com/spiffe/spire/releases/download/v1.12.6/spire-1.12.6-linux-amd64-musl.tar.gz
#   spire-agent                archive sha256 b1919bf6917f7ae74212d8008dcfe92b0f7238d6cb50efdd15f1a1205aebf538
#                              cross-checked against upstream spire-1.12.6-linux-amd64-musl_sha256sum.txt (match)
#   caddy             2.11.4   https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_amd64.tar.gz
#                              archive sha256 527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9
#                              cross-checked: upstream caddy_2.11.4_checksums.txt is sha512
#                              (8220d1f0…3e1c9 — see CADDY_SHA512 below), which matched the same download
#
#   The same versions are pinned for linux-arm64 (`__ARM64` variables in the
#   block below, recorded 2026-09-23): every asset was downloaded once and
#   hashed here, then cross-checked the same way — nats-server against the
#   release's upstream SHA256SUMS, spire against
#   spire-1.12.6-linux-arm64-musl_sha256sum.txt, caddy against the sha512 in
#   caddy_2.11.4_checksums.txt (all match). OpenBao again publishes only a
#   cosign `.sig`, so its arm64 hash is our own of a single download. The
#   extracted-binary hashes are our own on both arches.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_DIR="${OPENSESAME_MTLS_FIXTURE_DIR:-${ROOT}/.cache/mtls-fixtures}"

TOOLS=(nats-server nats-server-2.10 openbao spire-server spire-agent caddy)

# ---- pins -------------------------------------------------------------------
# One set of versions, two pinned asset sets: linux-amd64 (the hashes in the
# table above) and linux-arm64 (`__ARM64` below). `uname -m` selects which set
# every selected variable below holds.

PLAT=""
BOA_PLAT=""
case "$(uname -m)" in
  x86_64|amd64) PLAT="amd64"; BOA_PLAT="x86_64" ;;
  aarch64|arm64) PLAT="arm64"; BOA_PLAT="arm64" ;;
esac

sel() { # base name → the matching ${BASE}__AMD64 / ${BASE}__ARM64 value
  local var="${1}__${PLAT^^}"
  echo "${!var:-}"
}

NATS_VERSION="2.11.17"
NATS_ARCHIVE_SHA256__AMD64="ad608dd0ea8bbfa58c40e3b8f58ed67478eec26166ec49c502db8d17589b51b5"
NATS_BINARY_SHA256__AMD64="40e725f0fcd8142888ed87b779fc75d5f48224c737b916499c785ecf8157e610"
NATS_ARCHIVE_SHA256__ARM64="d21df24f262f34f8bf6d1f0bca557c08429e433fd9f60f6983105539ae517feb"
NATS_BINARY_SHA256__ARM64="7962af4d898f3e09e2425c60efccb7319feb0eec14168cc6eeada0a10bee474d"
NATS_ARCHIVE_SHA256="$(sel NATS_ARCHIVE_SHA256)"
NATS_BINARY_SHA256="$(sel NATS_BINARY_SHA256)"
NATS_URL="https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}/nats-server-v${NATS_VERSION}-linux-${PLAT}.tar.gz"

NATS210_VERSION="2.10.18"
NATS210_ARCHIVE_SHA256__AMD64="7760fe7347ba8e8daf4474811cf7fc301713aa8f3d4e0787d3e79a496dd537b2"
NATS210_BINARY_SHA256__AMD64="6f5acc8317159e478a713373daa08bc40b35c49946c527b907e211bef8d8546c"
NATS210_ARCHIVE_SHA256__ARM64="3f026443e902a21e787382ca10e1446bf02a8bb779224b1b7b33ea6483f76b02"
NATS210_BINARY_SHA256__ARM64="143b65ce3b75de78c423f330a7ad56c2958712a046ce9b00b306a0b88ac5a588"
NATS210_ARCHIVE_SHA256="$(sel NATS210_ARCHIVE_SHA256)"
NATS210_BINARY_SHA256="$(sel NATS210_BINARY_SHA256)"
NATS210_URL="https://github.com/nats-io/nats-server/releases/download/v${NATS210_VERSION}/nats-server-v${NATS210_VERSION}-linux-${PLAT}.tar.gz"

OPENBAO_VERSION="2.3.2"
OPENBAO_ARCHIVE_SHA256__AMD64="26ddcffecdcbb0a3a48b8713ddda83de3084886d3df13686ffddbb158855bdcf"
OPENBAO_BINARY_SHA256__AMD64="b594aa2254a13bd84b48ce76575e3a6c8297cc2cc598f673b05242aa417d893c"
OPENBAO_ARCHIVE_SHA256__ARM64="0243dc9b24f20f9c27f15da101365e9ef0ab42a92571a2ff6aecd6c275aa9de2"
OPENBAO_BINARY_SHA256__ARM64="7d0ccb712a61d429b41ffccbbfcefeb487c8e781df13a2ef25173e1db4e3e1f9"
OPENBAO_ARCHIVE_SHA256="$(sel OPENBAO_ARCHIVE_SHA256)"
OPENBAO_BINARY_SHA256="$(sel OPENBAO_BINARY_SHA256)"
OPENBAO_URL="https://github.com/openbao/openbao/releases/download/v${OPENBAO_VERSION}/bao_${OPENBAO_VERSION}_Linux_${BOA_PLAT}.tar.gz"

SPIRE_VERSION="1.12.6"
SPIRE_ARCHIVE_SHA256__AMD64="b1919bf6917f7ae74212d8008dcfe92b0f7238d6cb50efdd15f1a1205aebf538"
SPIRE_SERVER_BINARY_SHA256__AMD64="a70ee7e9a87292704b217eaec1505f89d8f9ce8b1dd576bc319ff17938b01b0c"
SPIRE_AGENT_BINARY_SHA256__AMD64="ccb9f39067ac1cc6d67685d3fbf256bd43d73df7f6b9e75f91d5522e024a703d"
SPIRE_ARCHIVE_SHA256__ARM64="d7cf6cd33eb0843f26d0a5e78d5ed9590ab600a230ca9a74045156a33a1fb162"
SPIRE_SERVER_BINARY_SHA256__ARM64="7181ff14701363a131632f9a4679e269023f6748d38b69d234b7de60a19539de"
SPIRE_AGENT_BINARY_SHA256__ARM64="6c35a99f94e5355f1283b6434575f47109a90ad3281694da8f95eb4744fcb461"
SPIRE_ARCHIVE_SHA256="$(sel SPIRE_ARCHIVE_SHA256)"
SPIRE_SERVER_BINARY_SHA256="$(sel SPIRE_SERVER_BINARY_SHA256)"
SPIRE_AGENT_BINARY_SHA256="$(sel SPIRE_AGENT_BINARY_SHA256)"
SPIRE_URL="https://github.com/spiffe/spire/releases/download/v${SPIRE_VERSION}/spire-${SPIRE_VERSION}-linux-${PLAT}-musl.tar.gz"

CADDY_VERSION="2.11.4"
CADDY_ARCHIVE_SHA256__AMD64="527fbf917c39189a1e3b31d34fa955601680b2d5c8055d2a87b8b9588dec7bb9"
CADDY_BINARY_SHA256__AMD64="b7105518e3ed1c0761f232e44fc09345535533c9cb0abf0e12809416c7ac64d9"
CADDY_ARCHIVE_SHA256__ARM64="52d42ae12b3462097e9868da6dfed3c9648ae12edd3b3638102312af84cb6904"
CADDY_BINARY_SHA256__ARM64="e1f904038fc11ca897ac5a12fdacfb2a7add02a8720c426d562a37f6fdad2afe"
CADDY_ARCHIVE_SHA256="$(sel CADDY_ARCHIVE_SHA256)"
CADDY_BINARY_SHA256="$(sel CADDY_BINARY_SHA256)"
CADDY_URL="https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${PLAT}.tar.gz"
# Upstream caddy_2.11.4_checksums.txt publishes sha512; kept for the record.
CADDY_SHA512__AMD64="8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9"
CADDY_SHA512__ARM64="d5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c"
# shellcheck disable=SC2034
CADDY_SHA512="$(sel CADDY_SHA512)"

# ---- helpers ----------------------------------------------------------------
die() { echo "mtls-fixtures: $*" >&2; exit 1; }

require_platform() {
  if [[ -z "${PLAT}" ]]; then
    echo "mtls-fixtures: unsupported platform $(uname -s)/$(uname -m) (pins are linux-amd64 and linux-arm64)" >&2
    exit 3
  fi
}

sha256_of() { sha256sum "$1" | awk '{print $1}'; }

check_sha256() { # file expected label
  local actual
  actual="$(sha256_of "$1")"
  if [[ "${actual}" != "$2" ]]; then
    echo "mtls-fixtures: sha256 MISMATCH for $3" >&2
    echo "  expected ${2}" >&2
    echo "  actual   ${actual}" >&2
    return 1
  fi
}

# tool → "VERSION|URL|ARCHIVE_SHA|DIRNAME|ARCHIVE_FILE|MEMBER|BINARY|BINARY_SHA"
spec() {
  case "$1" in
    nats-server)
      echo "${NATS_VERSION}|${NATS_URL}|${NATS_ARCHIVE_SHA256}|nats-server-${NATS_VERSION}|nats-server-v${NATS_VERSION}-linux-${PLAT}.tar.gz|nats-server-v${NATS_VERSION}-linux-${PLAT}/nats-server|nats-server|${NATS_BINARY_SHA256}" ;;
    nats-server-2.10)
      echo "${NATS210_VERSION}|${NATS210_URL}|${NATS210_ARCHIVE_SHA256}|nats-server-${NATS210_VERSION}|nats-server-v${NATS210_VERSION}-linux-${PLAT}.tar.gz|nats-server-v${NATS210_VERSION}-linux-${PLAT}/nats-server|nats-server|${NATS210_BINARY_SHA256}" ;;
    openbao)
      echo "${OPENBAO_VERSION}|${OPENBAO_URL}|${OPENBAO_ARCHIVE_SHA256}|openbao-${OPENBAO_VERSION}|bao_${OPENBAO_VERSION}_Linux_${BOA_PLAT}.tar.gz|bao|bao|${OPENBAO_BINARY_SHA256}" ;;
    spire-server)
      echo "${SPIRE_VERSION}|${SPIRE_URL}|${SPIRE_ARCHIVE_SHA256}|spire-${SPIRE_VERSION}|spire-${SPIRE_VERSION}-linux-${PLAT}-musl.tar.gz|spire-${SPIRE_VERSION}/bin/spire-server|spire-server|${SPIRE_SERVER_BINARY_SHA256}" ;;
    spire-agent)
      echo "${SPIRE_VERSION}|${SPIRE_URL}|${SPIRE_ARCHIVE_SHA256}|spire-${SPIRE_VERSION}|spire-${SPIRE_VERSION}-linux-${PLAT}-musl.tar.gz|spire-${SPIRE_VERSION}/bin/spire-agent|spire-agent|${SPIRE_AGENT_BINARY_SHA256}" ;;
    caddy)
      echo "${CADDY_VERSION}|${CADDY_URL}|${CADDY_ARCHIVE_SHA256}|caddy-${CADDY_VERSION}|caddy_${CADDY_VERSION}_linux_${PLAT}.tar.gz|caddy|caddy|${CADDY_BINARY_SHA256}" ;;
    *) die "unknown tool '$1' (known: ${TOOLS[*]})" ;;
  esac
}

field() { echo "$1" | cut -d'|' -f"$2"; }

download_archive() { # url dest expected_sha
  local url="$1" dest="$2" expected="$3" tmp
  if [[ -f "${dest}" ]] && check_sha256 "${dest}" "${expected}" "$(basename "${dest}") (cached)" 2>/dev/null; then
    return 0
  fi
  rm -f "${dest}"
  tmp="${dest}.part.$$"
  echo "mtls-fixtures: downloading $(basename "${dest}")" >&2
  if ! curl -fsSL --retry 3 --retry-delay 2 --max-time 600 -o "${tmp}" "${url}"; then
    rm -f "${tmp}"
    die "download failed: ${url}"
  fi
  if ! check_sha256 "${tmp}" "${expected}" "${url}"; then
    rm -f "${tmp}"
    exit 1
  fi
  mv -f "${tmp}" "${dest}"
}

extract_binary() { # archive member dest expected_sha
  local archive="$1" member="$2" dest="$3" expected="$4" tmpdir
  tmpdir="$(mktemp -d "${FIXTURE_DIR}/.extract.XXXXXX")"
  if ! tar -xzf "${archive}" -C "${tmpdir}" "${member}"; then
    rm -rf "${tmpdir}"
    die "member '${member}' missing from $(basename "${archive}")"
  fi
  if ! check_sha256 "${tmpdir}/${member}" "${expected}" "extracted $(basename "${dest}")"; then
    rm -rf "${tmpdir}"
    exit 1
  fi
  chmod 0755 "${tmpdir}/${member}"
  mv -f "${tmpdir}/${member}" "${dest}"
  rm -rf "${tmpdir}"
}

fetch_one() { # tool → prints binary path
  require_platform
  local s version url asha dir archive member bin bsha dest
  s="$(spec "$1")"
  version="$(field "${s}" 1)"; url="$(field "${s}" 2)"; asha="$(field "${s}" 3)"
  dir="${FIXTURE_DIR}/$(field "${s}" 4)"; archive="${dir}/$(field "${s}" 5)"
  member="$(field "${s}" 6)"; bin="$(field "${s}" 7)"; bsha="$(field "${s}" 8)"
  dest="${dir}/${bin}"
  mkdir -p "${dir}"
  if [[ -x "${dest}" ]] && check_sha256 "${dest}" "${bsha}" "${dest}" 2>/dev/null; then
    echo "${dest}"
    return 0
  fi
  download_archive "${url}" "${archive}" "${asha}"
  extract_binary "${archive}" "${member}" "${dest}" "${bsha}"
  echo "${1}=${version}" >"${dir}/.pin"
  echo "${dest}"
}

verify_one() { # tool → exit 1 on any mismatch
  require_platform
  local s dir archive bin dest asha bsha rc=0
  s="$(spec "$1")"
  dir="${FIXTURE_DIR}/$(field "${s}" 4)"; archive="${dir}/$(field "${s}" 5)"
  bin="$(field "${s}" 7)"; dest="${dir}/${bin}"
  asha="$(field "${s}" 3)"; bsha="$(field "${s}" 8)"
  if [[ ! -f "${archive}" ]]; then echo "mtls-fixtures: $1: archive not fetched (${archive})" >&2; rc=1
  else check_sha256 "${archive}" "${asha}" "$1 archive" || rc=1; fi
  if [[ ! -x "${dest}" ]]; then echo "mtls-fixtures: $1: binary not present (${dest})" >&2; rc=1
  else check_sha256 "${dest}" "${bsha}" "$1 binary" || rc=1; fi
  if [[ ${rc} -eq 0 ]]; then echo "mtls-fixtures: $1 ok ($(field "${s}" 1)) ${dest}"; fi
  return ${rc}
}

list_tools() {
  require_platform
  printf 'tool\tversion\tbinary\tarchive_sha256\tbinary_sha256\turl\n'
  local t s
  for t in "${TOOLS[@]}"; do
    s="$(spec "${t}")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${t}" "$(field "${s}" 1)" \
      "${FIXTURE_DIR}/$(field "${s}" 4)/$(field "${s}" 7)" "$(field "${s}" 3)" "$(field "${s}" 8)" "$(field "${s}" 2)"
  done
}

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' >&2
  exit 2
}

# ---- main -------------------------------------------------------------------
cmd="${1:-}"; arg="${2:-}"
case "${cmd}" in
  dir) echo "${FIXTURE_DIR}" ;;
  list) list_tools ;;
  version) [[ -n "${arg}" ]] || usage; require_platform; s="$(spec "${arg}")"; field "${s}" 1 ;;
  path) [[ -n "${arg}" ]] || usage; fetch_one "${arg}" ;;
  fetch)
    [[ -n "${arg}" ]] || usage
    mkdir -p "${FIXTURE_DIR}"
    if [[ "${arg}" == "all" ]]; then for t in "${TOOLS[@]}"; do fetch_one "${t}"; done
    else fetch_one "${arg}"; fi ;;
  verify)
    rc=0
    if [[ -z "${arg}" || "${arg}" == "all" ]]; then for t in "${TOOLS[@]}"; do verify_one "${t}" || rc=1; done
    else verify_one "${arg}" || rc=1; fi
    exit ${rc} ;;
  *) usage ;;
esac
