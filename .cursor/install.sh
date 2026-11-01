#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap (see environment.json). No secrets; no daemons.
set -euo pipefail

. .cursor/cloud-path.sh
export MISE_DATA_DIR="${MISE_DATA_DIR:-/opt/mise}"
case ":${PATH}:" in
  *:"${MISE_DATA_DIR}/shims":*) ;;
  *) PATH="${MISE_DATA_DIR}/shims:${PATH}" ;;
esac
export PATH
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"

# Personal dotfiles before project dependencies. Clone failure uses
# staging/tyler-dotfiles. The bootstrap does not elevate privileges.
bash scripts/dev/dotfiles-bootstrap.sh

# Node, npm, and Rust come from the locked mise config. `deps` runs npm ci.
mise install --locked
mise run deps
cargo fetch

# Grok Build subscription auth. Non-fatal when the Cursor store is absent
# (local dev). The installer prints status only, never auth file contents.
if [[ -f scripts/dev/grok-install-subscription-auth.sh ]]; then
  if ! bash scripts/dev/grok-install-subscription-auth.sh; then
    printf '%s\n' "grok subscription auth install skipped (store unavailable; non-fatal for local dev)"
  fi
fi

# Cursor Agent CLI for deepsec wave-2 Composer fallback (subscription `agent login` on the image).
if ! command -v cursor-agent >/dev/null 2>&1; then
  cursor_binary="$(node scripts/dev/install-cloud-cli.mjs cursor "$HOME/.local/share/cursor-agent/versions")"
  mkdir -p "$HOME/.local/bin"
  ln -sf "$cursor_binary" "$HOME/.local/bin/agent"
  ln -sf "$cursor_binary" "$HOME/.local/bin/cursor-agent"
fi
