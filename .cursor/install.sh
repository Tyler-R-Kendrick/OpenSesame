#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap (see environment.json). No secrets; no daemons.
set -euo pipefail

export PATH="/usr/local/cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"

corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
cargo +1.88.0 fetch
