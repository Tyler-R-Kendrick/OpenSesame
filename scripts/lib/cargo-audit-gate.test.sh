#!/usr/bin/env bash
# Exercise the real gate with a controlled scanner, including misleading clean JSON.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d /tmp/opensesame-cargo-audit-contract.XXXXXXXX)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -m 700 "$fixture/bin" "$fixture/reports"
cat > "$fixture/bin/cargo" <<'SCANNER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *' -V' ]]; then exit 0; fi
if [[ "$*" == *' --json' ]]; then
  printf '%s\n' '{"vulnerabilities":{"count":0,"list":[]}}'
  if [[ "$AUDIT_CASE" == json-error ]]; then exit 2; fi
else
  if [[ "$AUDIT_CASE" == text-error ]]; then
    echo 'fixture: advisory database fetch failed' >&2
    exit 2
  fi
fi
SCANNER
chmod 700 "$fixture/bin/cargo"
for audit_case in clean json-error text-error; do
  set +e
  PATH="$fixture/bin:$PATH" AUDIT_CASE="$audit_case" \
    OPENSESAME_AUDIT_DIR="$fixture/reports" \
    bash "$ROOT/scripts/audit/cargo-audit-gate.sh" > "$fixture/$audit_case.log" 2>&1
  status=$?
  set -e
  if [[ "$audit_case" == clean ]]; then
    [[ "$status" -eq 0 ]]
    rg -q 'gate: CLEAN' "$fixture/$audit_case.log"
  else
    [[ "$status" -ne 0 ]]
    rg -q 'gate: FAIL \(scanner statuses' "$fixture/$audit_case.log"
    if rg -q 'gate: CLEAN' "$fixture/$audit_case.log"; then exit 1; fi
  fi
done
printf '%s\n' 'cargo-audit gate contract: 3 cases passed'
