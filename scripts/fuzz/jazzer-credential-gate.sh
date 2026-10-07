#!/usr/bin/env bash
# Bounded feature campaign. Native engine only; async crypto is awaited.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
cd "$ROOT/tests/fuzz/jazzer"

if [[ ! -x node_modules/.bin/jazzer ]]; then
  printf '1\n' > "$OPENSESAME_AUDIT_DIR/native-loader.exit"
  echo "credential fuzz: native Jazzer.js is required; no fallback is permitted" >&2
  exit 1
fi
if node --input-type=module -e 'await import("@jazzer.js/core");' > "$OPENSESAME_AUDIT_DIR/native-loader.log" 2>&1; then
  printf '0\n' > "$OPENSESAME_AUDIT_DIR/native-loader.exit"
else
  status=$?
  printf '%s\n' "$status" > "$OPENSESAME_AUDIT_DIR/native-loader.exit"
  echo "credential fuzz: native Jazzer.js is required; no fallback is permitted" >&2
  exit 1
fi
for target in src/credential_canary_parsers src/credential_observation_parsers src/security-protocol/credential-observation-native; do
  [[ -f "$target.ts" ]] || { echo "credential fuzz: required target is missing" >&2; exit 1; }
done
mkdir -p "$OPENSESAME_AUDIT_DIR/artifacts" "$OPENSESAME_AUDIT_DIR/corpus"
node --import=tsx src/security-protocol/credential-corpus.ts "$OPENSESAME_AUDIT_DIR/corpus"
fail=0
for entry in canary:src/credential_canary_parsers observation:src/credential_observation_parsers crypto:src/security-protocol/credential-observation-native; do
  name="${entry%%:*}"
  target="${entry#*:}"
  echo "--> $name"
  if NODE_OPTIONS="${NODE_OPTIONS:-} --import=tsx" node_modules/.bin/jazzer "$target" --timeout=5000 -- \
      -max_total_time=60 -max_len=8194 \
      -artifact_prefix="$OPENSESAME_AUDIT_DIR/artifacts/$name-" \
      "$OPENSESAME_AUDIT_DIR/corpus/$name" > "$OPENSESAME_AUDIT_DIR/$name.log" 2>&1; then
    printf '0\n' > "$OPENSESAME_AUDIT_DIR/$name.exit"
  else
    status=$?
    printf '%s\n' "$status" > "$OPENSESAME_AUDIT_DIR/$name.exit"
    fail=1
  fi
done
if [[ "$fail" -ne 0 ]]; then
  echo "credential fuzz: FAIL; inspect actual engine logs and artifacts" >&2
  exit 1
fi
echo "credential fuzz: CLEAN native (three bounded targets; not a formal proof)"
