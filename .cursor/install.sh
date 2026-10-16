#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap (see environment.json). No secrets; no daemons.
set -euo pipefail

export PATH="/usr/local/cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"

corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
cargo +1.88.0 fetch

# Cursor Agent CLI for deepsec wave-2 Composer fallback (subscription `agent login` on the image).
if ! command -v cursor-agent >/dev/null 2>&1; then
  curl -fsSL https://cursor.com/install | bash
fi
