#!/usr/bin/env bash
# Idempotent, rootless personal-dotfiles bootstrap.
#
# Clones DOTFILES_REPO (default Tyler Kendrick's dotfiles). When the clone
# or refresh fails, uses staging/tyler-dotfiles in this repository so CI can
# install before that repository is published. Then runs that tree's
# install.sh without elevating privileges.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
repo="${DOTFILES_REPO:-https://github.com/Tyler-R-Kendrick/dotfiles.git}"
staging="${ROOT}/staging/tyler-dotfiles"

if [[ -z "${HOME:-}" || ! -d "${HOME}" || ! -w "${HOME}" ]]; then
  printf 'dotfiles-bootstrap: HOME must be a writable directory\n' >&2
  exit 1
fi

dest="${HOME}/.local/share/opensesame/tyler-dotfiles"
case "${dest}" in
  "${HOME}/"*) ;;
  *)
    printf 'dotfiles-bootstrap: checkout must stay under HOME\n' >&2
    exit 1
    ;;
esac

export GIT_TERMINAL_PROMPT=0

# install.sh points MISE_DATA_DIR at the user data dir. A project mise shim
# follows that variable, so prefer the real Node binary when the locked
# toolchain is already installed.
if command -v mise >/dev/null 2>&1; then
  node_prefix=""
  if command -v timeout >/dev/null 2>&1; then
    node_prefix="$(timeout 10 mise where node 2>/dev/null || true)"
  else
    node_prefix="$(mise where node 2>/dev/null || true)"
  fi
  if [[ -n "${node_prefix}" && -x "${node_prefix}/bin/node" ]]; then
    PATH="${node_prefix}/bin:${PATH}"
  fi
fi
mkdir -p "${HOME}/.local/bin"
case ":${PATH}:" in
  *:"${HOME}/.local/bin":*) ;;
  *) PATH="${HOME}/.local/bin:${PATH}" ;;
esac
export PATH

tree=""
if command -v git >/dev/null 2>&1 && [[ -d "${dest}/.git" ]]; then
  if git -C "${dest}" fetch --depth 1 origin \
    && git -C "${dest}" reset --hard FETCH_HEAD \
    && [[ -f "${dest}/install.sh" ]]; then
    tree="${dest}"
  elif [[ -f "${dest}/install.sh" ]]; then
    printf 'dotfiles-bootstrap: refresh failed; using existing checkout\n' >&2
    tree="${dest}"
  fi
fi

if [[ -z "${tree}" ]]; then
  rm -rf -- "${dest}"
  mkdir -p "$(dirname "${dest}")"
  if command -v git >/dev/null 2>&1 \
    && git clone --depth 1 -- "${repo}" "${dest}" \
    && [[ -f "${dest}/install.sh" ]]; then
    tree="${dest}"
  else
    rm -rf -- "${dest}"
  fi
fi

if [[ -z "${tree}" ]]; then
  if [[ -f "${staging}/install.sh" ]]; then
    printf 'dotfiles-bootstrap: clone failed; using %s\n' "${staging}" >&2
    tree="${staging}"
  else
    printf 'dotfiles-bootstrap: clone failed and %s/install.sh is missing\n' \
      "${staging}" >&2
    exit 1
  fi
fi

bash "${tree}/install.sh"
