#!/usr/bin/env bash
# Idempotent, rootless bootstrap for Tyler Kendrick's personal dotfiles.
#
# Installs a checksum-pinned mise release tarball (the same linux digests as
# the OpenSesame Cursor image), the latest tools in mise.toml, and the
# checksum-pinned Grok Build and Cursor Agent CLIs from vendor/downloads.json.
# Re-running is safe. The script does not elevate privileges and does not
# print secret file contents.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "${HOME:-}" || ! -d "${HOME}" || ! -w "${HOME}" ]]; then
  printf 'HOME must be a writable directory\n' >&2
  exit 1
fi

# User-owned data dirs. A system image may point MISE_DATA_DIR at a
# root-owned path such as /opt/mise. This installer does not write there.
export MISE_DATA_DIR="${HOME}/.local/share/mise"
export MISE_CACHE_DIR="${HOME}/.cache/mise"
export MISE_CONFIG_DIR="${HOME}/.config/mise"
export MISE_YES=1
export PATH="${HOME}/.local/bin:${MISE_DATA_DIR}/shims:${PATH}"

mkdir -p \
  "${HOME}/.local/bin" \
  "${MISE_DATA_DIR}" \
  "${MISE_CACHE_DIR}" \
  "${MISE_CONFIG_DIR}" \
  "${HOME}/.config/tyler-dotfiles/stamps" \
  "${HOME}/.agents/skills" \
  "${HOME}/.claude/skills"

# https://github.com/jdx/mise/releases/download/v2026.10.18/SHASUMS256.txt
# linux-x64 and linux-arm64 match the OpenSesame Cursor image Dockerfile.
MISE_VERSION="2026.10.18"

mise_target=""
mise_sha=""
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64 | Linux-amd64)
    mise_target="linux-x64"
    mise_sha="0d41b60745a6273a80089c86f80d8729042d2f57f87fda70aecc7d1c3ffbd3be"
    ;;
  Linux-aarch64 | Linux-arm64)
    mise_target="linux-arm64"
    mise_sha="c5a49a47f8184f5649f3d8685b408bd72325a823f41cf618c60f3ffc303090a1"
    ;;
  Darwin-arm64)
    mise_target="macos-arm64"
    mise_sha="1b1cd6ad4a6176db5ddaf03bf71e131b26324af09cfcf14d7d7038bee60be85d"
    ;;
  Darwin-x86_64)
    mise_target="macos-x64"
    mise_sha="81931f325cfc97481faa558297dbd1595aa9c4e745fd09c02479593449e082c0"
    ;;
  *)
    printf 'unsupported mise platform: %s %s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual=""
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "${file}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "${file}" | awk '{print $1}')"
  else
    printf 'sha256sum or shasum is required to verify mise\n' >&2
    exit 1
  fi
  if [[ "${actual}" != "${expected}" ]]; then
    printf 'checksum mismatch for %s\nexpected %s\nactual   %s\n' \
      "${file}" "${expected}" "${actual}" >&2
    exit 1
  fi
}

install_mise() {
  local bin="${HOME}/.local/bin/mise"
  local current=""
  if [[ -x "${bin}" ]]; then
    current="$("${bin}" --version 2>/dev/null || true)"
    if [[ "${current}" == *"${MISE_VERSION}"* ]]; then
      printf 'mise %s present at %s\n' "${MISE_VERSION}" "${bin}"
      return 0
    fi
  fi

  local tmp archive url
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/tyler-dotfiles-mise.XXXXXX")"
  cleanup_mise_tmp() {
    if [[ -n "${tmp:-}" ]]; then
      rm -rf -- "${tmp}"
    fi
  }
  trap cleanup_mise_tmp EXIT
  archive="mise-v${MISE_VERSION}-${mise_target}.tar.gz"
  url="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/${archive}"
  curl \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    --fail \
    --show-error \
    --silent \
    --location \
    --output "${tmp}/${archive}" \
    "${url}"
  verify_sha256 "${tmp}/${archive}" "${mise_sha}"
  # Same member the OpenSesame image extracts. Checksum already passed, so
  # a missing path is a hard tar error rather than a pipefail false alarm.
  tar -xzf "${tmp}/${archive}" -C "${tmp}" mise/bin/mise
  if [[ ! -f "${tmp}/mise/bin/mise" ]]; then
    printf 'pinned mise archive is missing mise/bin/mise\n' >&2
    exit 1
  fi
  if command -v install >/dev/null 2>&1; then
    install -m 0755 "${tmp}/mise/bin/mise" "${bin}"
  else
    cp "${tmp}/mise/bin/mise" "${bin}"
    chmod 0755 "${bin}"
  fi
  trap - EXIT
  rm -rf -- "${tmp}"
  "${bin}" --version
}

stamp_path() {
  local dest="$1"
  local rel="${dest#"${HOME}/"}"
  printf '%s\n' "${HOME}/.config/tyler-dotfiles/stamps/${rel}.managed"
}

install_managed() {
  local src="$1"
  local dest="$2"
  local mode="${3:-0644}"
  local stamp
  stamp="$(stamp_path "${dest}")"
  mkdir -p "$(dirname "${dest}")" "$(dirname "${stamp}")"
  if [[ -e "${dest}" && ! -f "${stamp}" ]]; then
    printf 'skip %s (existing file is not managed by tyler-dotfiles)\n' "${dest}"
    return 0
  fi
  if [[ -f "${dest}" ]] && cmp -s "${src}" "${dest}"; then
    : >"${stamp}"
    return 0
  fi
  cp "${src}" "${dest}"
  chmod "${mode}" "${dest}"
  : >"${stamp}"
  printf 'installed %s\n' "${dest}"
}

ensure_source_line() {
  local file="$1"
  if [[ -f "${file}" ]] && grep -qF '.config/tyler-dotfiles/env.sh' "${file}"; then
    return 0
  fi
  mkdir -p "$(dirname "${file}")"
  touch "${file}"
  # $HOME is expanded by the login shell that sources this line, not now.
  # shellcheck disable=SC2016
  printf '\n# managed-by: tyler-dotfiles\n. "$HOME/.config/tyler-dotfiles/env.sh"\n' >>"${file}"
}

personal_mise_active() {
  local config="${HOME}/.config/mise/config.toml"
  local stamp
  stamp="$(stamp_path "${config}")"
  [[ -f "${stamp}" && -f "${config}" ]]
}

install_mise_tools() {
  install_managed "${ROOT}/mise.toml" "${HOME}/.config/mise/config.toml" 0644
  if ! personal_mise_active; then
    printf 'personal mise tools skipped; %s was left in place\n' \
      "${HOME}/.config/mise/config.toml" >&2
    return 0
  fi
  # Install from the home directory so a parent OpenSesame mise.toml is not
  # merged in while this tree is nested under that repo.
  (
    cd "${HOME}"
    if ! mise trust -y "${HOME}/.config/mise/config.toml"; then
      mise trust "${HOME}/.config/mise/config.toml"
    fi
    mise install
    # tool id in mise.toml, then the executable name `mise which` accepts.
    # github-cli installs gh. ripgrep installs rg.
    tool_bins="fd:fd github-cli:gh jq:jq ripgrep:rg shellcheck:shellcheck"
    for pair in ${tool_bins}; do
      bin_name="${pair##*:}"
      bin_path="$(mise which "${bin_name}")"
      ln -sfn "${bin_path}" "${HOME}/.local/bin/${bin_name}"
      printf 'linked %s -> %s\n' "${bin_name}" "${bin_path}"
    done
  )
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    printf 'node is required to verify checksum-pinned Grok and Cursor CLIs\n' >&2
    exit 1
  fi
}

# Exit 0 when vendor/downloads.json has an artifact for this machine.
# Exit 2 when the pin file has no artifact for the platform.
has_pinned_artifact() {
  local tool="$1"
  node --input-type=module - "${tool}" "${ROOT}/vendor/downloads.json" <<'NODE'
import { readFileSync } from "node:fs";

const tool = process.argv[2];
const manifest = JSON.parse(readFileSync(process.argv[3], "utf8"));
const key = `${process.platform}-${process.arch}`;
const artifact = manifest[tool] && manifest[tool].artifacts[key];
if (!artifact) process.exit(2);
NODE
}

install_grok() {
  local dest="${HOME}/.local/bin/grok"
  local version have rc
  version="$(
    node -e 'const m=require(process.argv[1]); process.stdout.write(m.grok.version)' \
      "${ROOT}/vendor/downloads.json"
  )"
  if [[ -x "${dest}" ]]; then
    have="$("${dest}" --version 2>/dev/null || true)"
    if [[ "${have}" == *"${version}"* ]]; then
      printf 'grok %s present\n' "${version}"
      return 0
    fi
  fi
  set +e
  has_pinned_artifact grok
  rc=$?
  set -e
  if [[ "${rc}" -eq 2 ]]; then
    printf 'grok: no pinned artifact for this platform; skipped\n'
    return 0
  fi
  if [[ "${rc}" -ne 0 ]]; then
    return "${rc}"
  fi
  node "${ROOT}/vendor/install-cloud-cli.mjs" grok "${dest}"
  "${dest}" --version
}

install_cursor_agent() {
  local versions="${HOME}/.local/share/cursor-agent/versions"
  local version binary rc
  version="$(
    node -e 'const m=require(process.argv[1]); process.stdout.write(m.cursor.version)' \
      "${ROOT}/vendor/downloads.json"
  )"
  binary="${versions}/${version}/cursor-agent"
  if [[ -x "${binary}" ]]; then
    printf 'cursor-agent %s present\n' "${version}"
  else
    set +e
    has_pinned_artifact cursor
    rc=$?
    set -e
    if [[ "${rc}" -eq 2 ]]; then
      printf 'cursor-agent: no pinned artifact for this platform; skipped\n'
      return 0
    fi
    if [[ "${rc}" -ne 0 ]]; then
      return "${rc}"
    fi
    binary="$(node "${ROOT}/vendor/install-cloud-cli.mjs" cursor "${versions}")"
  fi
  if [[ -z "${binary}" || ! -x "${binary}" ]]; then
    printf 'cursor-agent install did not produce %s\n' "${binary}" >&2
    exit 1
  fi
  ln -sfn "${binary}" "${HOME}/.local/bin/cursor-agent"
  ln -sfn "${binary}" "${HOME}/.local/bin/agent"
  "${binary}" --version
}

install_grok_auth() {
  # Status only. Never print auth file contents.
  # Same store path as OpenSesame scripts/dev/grok-install-subscription-auth.sh.
  local source="${GROK_SUBSCRIPTION_AUTH_SOURCE:-/cursor/stores/bot/grok/auth.json}"
  local dest="${HOME}/.grok/auth.json"
  if [[ -f "${source}" && -r "${source}" ]]; then
    mkdir -p "${HOME}/.grok"
    cp "${source}" "${dest}"
    chmod 600 "${dest}"
    printf 'grok subscription auth install: ran\n'
  else
    printf 'grok subscription auth install: skipped\n'
  fi
}

install_harness() {
  install_managed \
    "${ROOT}/harness/shell/env.sh" \
    "${HOME}/.config/tyler-dotfiles/env.sh" \
    0644
  install_managed \
    "${ROOT}/harness/shell/stitch-env.sh" \
    "${HOME}/.config/tyler-dotfiles/stitch-env.sh" \
    0644
  ensure_source_line "${HOME}/.bashrc"
  ensure_source_line "${HOME}/.profile"
  install_managed \
    "${ROOT}/harness/grok/config.toml" \
    "${HOME}/.grok/config.toml" \
    0644
  install_managed \
    "${ROOT}/harness/cursor/rules/grok-build-first.mdc" \
    "${HOME}/.cursor/rules/grok-build-first.mdc" \
    0644
  install_managed \
    "${ROOT}/harness/cursor/rules/kimi-first.mdc" \
    "${HOME}/.cursor/rules/kimi-first.mdc" \
    0644
  install_managed \
    "${ROOT}/harness/claude/settings.local.json" \
    "${HOME}/.claude/settings.json" \
    0644
  if [[ -e "${HOME}/.kimi-code/config.toml" ]]; then
    printf 'skip %s (kimi login owns this file)\n' "${HOME}/.kimi-code/config.toml"
  else
    install_managed \
      "${ROOT}/harness/kimi/config.toml" \
      "${HOME}/.kimi-code/config.toml" \
      0644
  fi
}

install_mise
install_mise_tools
require_node
install_grok
install_cursor_agent
install_grok_auth
install_harness
printf 'tyler-dotfiles: install complete\n'
