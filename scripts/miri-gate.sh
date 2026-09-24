#!/usr/bin/env bash
# Periodic Miri on crates that stay off heavy FFI.
# Pin is documented in docs/validation/fuzzing.md. Override with MIRI_TOOLCHAIN.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Prefer an installed nightly; do not install one from this script.
TOOLCHAIN="${MIRI_TOOLCHAIN:-nightly}"

if ! rustup toolchain list | grep -q "^${TOOLCHAIN}"; then
  echo "miri-gate: toolchain $TOOLCHAIN is not installed." >&2
  echo "  rustup toolchain install nightly && rustup component add miri --toolchain nightly" >&2
  echo "This gate is optional and is not part of pnpm verify." >&2
  exit 1
fi

if ! rustup component list --toolchain "$TOOLCHAIN" | grep -q '^miri.*installed'; then
  echo "miri-gate: miri component missing on $TOOLCHAIN" >&2
  echo "  rustup component add miri --toolchain $TOOLCHAIN" >&2
  exit 1
fi

echo "==> cargo +$TOOLCHAIN miri test (lib, selected crates)"
export MIRIFLAGS="${MIRIFLAGS:--Zmiri-disable-isolation}"
export PROPTEST_CASES="${PROPTEST_CASES:-1}"
cargo "+$TOOLCHAIN" miri test \
  -p opensesame-domain \
  -p opensesame-redaction \
  -p opensesame-claims \
  -p opensesame-audit \
  -p opensesame-grants \
  --lib

# The proof crate's signature paths enter AWS-LC FFI, which Miri cannot
# execute. Its pure replay cache remains useful undefined-behavior coverage.
cargo "+$TOOLCHAIN" miri test -p opensesame-proof --lib 'replay::tests::'

# Full Argon2/XChaCha execution under Miri duplicates library-level coverage and
# is prohibitively slow. Keep the vault's trust-boundary rejection paths here.
for filter in \
  a_stored_nonce_of_the_wrong_length_is_an_error_not_a_panic \
  unsupported_version_rejected; do
  cargo "+$TOOLCHAIN" miri test -p opensesame-human-vault --lib "$filter"
done

echo "miri-gate: CLEAN"
