#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap (see environment.json). No secrets; no daemons.
set -euo pipefail

. .cursor/cloud-path.sh
export PATH="/usr/local/cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"

corepack enable
corepack prepare pnpm@9.15.0 --activate
bash scripts/dev/install-dependencies.sh
cargo +1.88.0 fetch

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
