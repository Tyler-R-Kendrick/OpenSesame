#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

rg -Fq 'pnpm audit:clippy' .githooks/pre-commit
node -e 'const scripts = require("./package.json").scripts; if (!scripts.verify.includes("pnpm audit:clippy")) process.exit(1)'
rg -Fq 'cargo +1.88.0 fmt --all -- --check' scripts/clippy-gate.sh
rg -Fq -- '--workspace --all-targets --all-features' scripts/clippy-gate.sh
rg -Fq -- '-D clippy::pedantic' scripts/clippy-gate.sh
rg -Fq -- '-D clippy::cognitive_complexity' scripts/clippy-gate.sh
rg -Fq -- '-D clippy::excessive_nesting' scripts/clippy-gate.sh
rg -Fxq 'cognitive-complexity-threshold = 25' clippy.toml
rg -Fxq 'too-many-lines-threshold = 100' clippy.toml
rg -Fxq 'too-many-arguments-threshold = 7' clippy.toml
rg -Fxq 'excessive-nesting-threshold = 4' clippy.toml
rg -Fxq 'type-complexity-threshold = 250' clippy.toml

echo "rust lint contract: OK"
