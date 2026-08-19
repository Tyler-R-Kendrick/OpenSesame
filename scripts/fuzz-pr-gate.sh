#!/usr/bin/env bash
# Short libFuzzer pass over targets whose crates changed vs origin/main.
# This is the ClusterFuzzLite "PR" analogue. It is not wired into pnpm verify.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SECONDS_PER_TARGET="${FUZZ_SECONDS:-60}"
BASE="${FUZZ_DIFF_BASE:-origin/main}"

if [[ ! -d fuzz/fuzz_targets ]]; then
  echo "fuzz-pr-gate: fuzz/ is missing" >&2
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "fuzz-pr-gate: cargo not on PATH" >&2
  exit 1
fi

if ! cargo fuzz --version >/dev/null 2>&1; then
  echo "fuzz-pr-gate: cargo-fuzz is not installed." >&2
  echo "  cargo install cargo-fuzz" >&2
  echo "  rustup toolchain install nightly  # cargo-fuzz needs nightly rustc" >&2
  exit 1
fi

map_targets() {
  local crate="$1"
  case "$crate" in
    crates/domain/*|crates/grants/*) echo capability_algebra grant_attenuation grant_serde canonical_json resource_match protocol_negotiate ;;
    crates/proof/*) echo jwt_jwk uri_normalize replay_cache ;;
    crates/authn/*) echo token_audience device_auth oidc_discovery ;;
    crates/redaction/*) echo redaction ;;
    crates/human-vault/*) echo vault_envelope ;;
    crates/claims/*) echo claim_replay ;;
    crates/audit/*) echo receipt_verify ;;
    crates/env-spec/*) echo env_spec ;;
    crates/connection-broker/*) echo connector_manifest broker_seal github_webhook_hmac ;;
    crates/authz/*) echo nats_callout_eval ;;
    crates/task-bus/*) echo taskbus_url xkeys_envelope ;;
    crates/xkeys/*) echo xkeys_envelope ;;
    crates/protocol-mcp/*) echo mcp_authz resource_match ;;
    crates/protocol-aauth/*) echo aauth_parse protocol_negotiate ;;
    crates/provider-openbao/*) echo openbao_response ;;
    crates/provider-openfga/*) echo openfga_response ;;
    crates/rotation/*) echo rotation_fsm ;;
    fuzz/*) echo ALL ;;
    *) ;;
  esac
}

targets=""
if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  while IFS= read -r path; do
    mapped="$(map_targets "$path")"
    if [[ "$mapped" == *ALL* ]]; then
      targets="ALL"
      break
    fi
    targets="$targets $mapped"
  done < <(git diff --name-only "$BASE"...HEAD 2>/dev/null || git diff --name-only "$BASE")
else
  targets="capability_algebra grant_attenuation canonical_json resource_match jwt_jwk token_audience redaction vault_envelope"
fi

if [[ -z "${targets// }" ]]; then
  echo "fuzz-pr-gate: no mapped Rust fuzz targets in the diff; running the phase-1 set"
  targets="capability_algebra grant_attenuation canonical_json resource_match jwt_jwk token_audience redaction vault_envelope"
fi

if [[ "$targets" == *ALL* ]]; then
  targets=""
  for f in fuzz/fuzz_targets/*.rs; do
    targets="$targets $(basename "$f" .rs)"
  done
fi

# Unique
targets="$(echo "$targets" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')"

echo "==> fuzz-pr-gate: ${SECONDS_PER_TARGET}s each — $targets"
fail=0
for target in $targets; do
  corpus="fuzz/corpus/$target"
  mkdir -p "$corpus" fuzz/artifacts
  echo "--> cargo fuzz run $target -max_total_time=$SECONDS_PER_TARGET"
  if ! cargo fuzz run "$target" --fuzz-dir fuzz -- \
      -max_total_time="$SECONDS_PER_TARGET" \
      -timeout=10 \
      -artifact_prefix="$ROOT/fuzz/artifacts/" \
      "$corpus"; then
    echo "fuzz-pr-gate: FAIL $target" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "fuzz-pr-gate: FAIL (see fuzz/artifacts/)" >&2
  exit 1
fi
echo "fuzz-pr-gate: CLEAN"
