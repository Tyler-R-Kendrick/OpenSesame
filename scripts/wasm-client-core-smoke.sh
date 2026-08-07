#!/usr/bin/env bash
# Smoke: client-core builds for wasm32; wasm-bindgen façade typechecks on host.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo check -p opensesame-client-core --target wasm32-unknown-unknown
# Bindings compile (host target) — full wasm-pack packaging is optional CI later.
cargo check -p opensesame-client-core --features wasm-bindgen
echo "wasm-client-core-smoke OK"
