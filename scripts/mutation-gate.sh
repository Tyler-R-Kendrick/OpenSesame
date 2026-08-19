#!/usr/bin/env bash
# Mutation testing over the crates whose tests are load-bearing.
#
# Coverage says a line ran. Mutation says a test would have noticed if that
# line were wrong — which is the property this repo actually depends on, since
# most of its suites exist to refuse things rather than to exercise paths.
#
# Scoped deliberately: these are the pure decision crates where a surviving
# mutant means a fence that does not fence. Running the whole workspace would
# take hours and drown the signal in mutants of glue code nobody asserts on.
#
# Optional, and not part of `pnpm verify` — it is far too slow for a pre-push
# gate. Run it when changing an authorization decision, and read the survivors.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v cargo >/dev/null 2>&1; then
  echo "mutation-gate: cargo not on PATH" >&2
  exit 1
fi

if ! cargo mutants --version >/dev/null 2>&1; then
  echo "mutation-gate: cargo-mutants is not installed." >&2
  echo "  cargo install --locked cargo-mutants" >&2
  echo "This gate is optional and is not part of pnpm verify." >&2
  exit 1
fi

# One package per invocation: cargo-mutants reports per-package, and a single
# combined run makes it hard to see which fence lost its test.
PACKAGES=(
  opensesame-domain      # grants, attenuation, availability, state machines
  opensesame-relay       # relayed-execution admission rules
  opensesame-connection-detect  # the value-blind detection contract
  opensesame-grants      # delegation attenuation
  opensesame-authz       # authority-use fences
  opensesame-claims      # claim token and user-code hashing
)

TIMEOUT="${MUTANTS_TIMEOUT:-90}"
status=0

for pkg in "${PACKAGES[@]}"; do
  echo "==> cargo mutants -p ${pkg}"
  if ! cargo mutants \
    -p "$pkg" \
    --timeout "$TIMEOUT" \
    --no-shuffle \
    --in-place; then
    echo "mutation-gate: survivors in ${pkg}" >&2
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo >&2
  echo "mutation-gate: SURVIVORS — a mutant lived, so some assertion is missing." >&2
  echo "Read mutants.out/missed.txt: each entry is a change no test objected to." >&2
  exit 1
fi

echo "mutation-gate: CLEAN"
