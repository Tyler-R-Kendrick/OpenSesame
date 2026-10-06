#!/usr/bin/env bash
# Run immutable copies of the production gates against controlled scanner binaries.
set -euo pipefail
SOURCE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d /tmp/opensesame-scanner-status-contract.XXXXXXXX)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/checkout/scripts/audit" "$fixture/checkout/scripts/lib" \
  "$fixture/checkout/.tools/bin" "$fixture/bin" "$fixture/reports"
chmod 700 "$fixture/reports"
cp "$SOURCE_ROOT/scripts/lib/audit-directory.sh" "$fixture/checkout/scripts/lib/"
cp "$SOURCE_ROOT/scripts/audit/osv-scanner-gate.sh" \
  "$SOURCE_ROOT/scripts/audit/semgrep-gate.sh" "$fixture/checkout/scripts/audit/"
cp "$SOURCE_ROOT/scripts/audit/cve-lite-gate.sh" "$fixture/checkout/scripts/audit/"
cat > "$fixture/checkout/.tools/bin/osv-scanner" <<'SCANNER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == --version ]]; then echo 'osv-scanner version: 2.5.0'; exit 0; fi
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output-file ]]; then
    printf '%s\n' '{"results":[]}' > "$2"
    break
  fi
  shift
done
exit "$SCANNER_STATUS"
SCANNER
cat > "$fixture/bin/semgrep" <<'SCANNER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'fixture: controlled scanner invocation'
exit "$SCANNER_STATUS"
SCANNER
chmod 700 "$fixture/checkout/.tools/bin/osv-scanner" "$fixture/bin/semgrep"
for gate in osv-scanner semgrep; do
  for scanner_status in 0 1 3; do
    set +e
    PATH="$fixture/bin:$PATH" SCANNER_STATUS="$scanner_status" \
      OPENSESAME_AUDIT_DIR="$fixture/reports" \
      bash "$fixture/checkout/scripts/audit/$gate-gate.sh" \
      > "$fixture/$gate-$scanner_status.log" 2>&1
    status=$?
    set -e
    if [[ "$scanner_status" -eq 0 ]]; then
      [[ "$status" -eq 0 ]]
      rg -q 'gate: CLEAN' "$fixture/$gate-$scanner_status.log"
    else
      [[ "$status" -ne 0 ]]
      rg -q 'gate: FAIL' "$fixture/$gate-$scanner_status.log"
      if rg -q 'gate: CLEAN' "$fixture/$gate-$scanner_status.log"; then exit 1; fi
    fi
  done
done
cat > "$fixture/bin/pnpm" <<'SCANNER'
#!/usr/bin/env bash
exit 0
SCANNER
cat > "$fixture/bin/cve-lite" <<'SCANNER'
#!/usr/bin/env bash
set -euo pipefail
stage=scan
[[ "$1" == overrides ]] && stage=overrides
filename="cve-lite-$stage-fixture.json"
complete=true
status=0
if [[ "$stage" == "$CVE_TEST_STAGE" ]]; then
  status="$SCANNER_STATUS"
  complete="$CVE_TEST_COMPLETE"
fi
if [[ "$stage" == overrides ]]; then
  if [[ -n "${CVE_TEST_SCOPED_REPORT:-}" ]]; then
    cp "$CVE_TEST_SCOPED_REPORT" "$filename"
  elif [[ "${CVE_TEST_OVERRIDE_WARNINGS:-false}" == true ]]; then
    printf '%s\n' '{"findings":[{"ruleId":"OA002","details":"pinned to \"-\""}],"skippedOverrideRules":[]}' > "$filename"
  elif [[ "$complete" == false ]]; then
    printf '%s\n' '{"findings":[],"skippedOverrideRules":[],"complete":false}' > "$filename"
  else
    printf '%s\n' '{"findings":[],"skippedOverrideRules":[]}' > "$filename"
  fi
else
  printf '{"status":"ok","complete":%s,"findingCount":0,"findings":[]}\n' "$complete" > "$filename"
fi
printf 'JSON saved to %s\n' "$filename"
exit "$status"
SCANNER
chmod 700 "$fixture/bin/pnpm" "$fixture/bin/cve-lite"
for stage in scan overrides; do
  for scenario in clean clean-looking-status-1 clean-looking-status-3 incomplete; do
    scanner_status=0
    complete=true
    [[ "$scenario" == clean-looking-status-1 ]] && scanner_status=1
    [[ "$scenario" == clean-looking-status-3 ]] && scanner_status=3
    [[ "$scenario" == incomplete ]] && complete=false
    set +e
    PATH="$fixture/bin:$PATH" SCANNER_STATUS="$scanner_status" \
      CVE_TEST_STAGE="$stage" CVE_TEST_COMPLETE="$complete" \
      OPENSESAME_AUDIT_DIR="$fixture/reports" \
      bash "$fixture/checkout/scripts/audit/cve-lite-gate.sh" \
      > "$fixture/cve-$stage-$scenario.log" 2>&1
    status=$?
    set -e
    if [[ "$scenario" == clean ]]; then
      [[ "$status" -eq 0 ]]
      rg -q 'gate: CLEAN' "$fixture/cve-$stage-$scenario.log"
    else
      [[ "$status" -ne 0 ]]
      if rg -q 'gate: CLEAN' "$fixture/cve-$stage-$scenario.log"; then exit 1; fi
    fi
  done
done
PATH="$fixture/bin:$PATH" SCANNER_STATUS=1 CVE_TEST_STAGE=overrides \
  CVE_TEST_COMPLETE=true CVE_TEST_OVERRIDE_WARNINGS=true \
  OPENSESAME_AUDIT_DIR="$fixture/reports" \
  bash "$fixture/checkout/scripts/audit/cve-lite-gate.sh" \
  > "$fixture/cve-override-validated-warning.log" 2>&1
rg -q 'gate: CLEAN' "$fixture/cve-override-validated-warning.log"

# Execute the production metadata helper; fixture package files contain no code.
cp "$SOURCE_ROOT/scripts/lib/scoped-override-evidence.mjs" "$fixture/checkout/scripts/lib/"
mkdir -p "$fixture/checkout/node_modules/parent/node_modules/child"
ln -s "$SOURCE_ROOT/node_modules/zod" "$fixture/checkout/node_modules/zod"
printf '%s\n' '{"pnpm":{"overrides":{"parent>child":"2.4.0","child":"2.4.0"}}}' \
  > "$fixture/checkout/package.json"
printf '%s\n' '{"name":"parent","version":"1.0.0","dependencies":{"child":"^2.0.0"}}' \
  > "$fixture/checkout/node_modules/parent/package.json"
for scenario in scoped-good scoped-below scoped-unresolved global-only wrong-rule; do
  rule=OA006
  scope='parent>child'
  [[ "$scenario" == global-only ]] && scope=child
  [[ "$scenario" == wrong-rule ]] && rule=OA005
  printf '{"findings":[{"ruleId":"%s","package":{"name":"child"},"location":{"file":"package.json","jsonPath":"/pnpm/overrides/%s"}}],"skippedOverrideRules":[]}\n' \
    "$rule" "$scope" > "$fixture/scoped-report.json"
  version=2.4.0
  [[ "$scenario" == scoped-below ]] && version=2.3.9
  printf '{"name":"child","version":"%s"}\n' "$version" \
    > "$fixture/checkout/node_modules/parent/node_modules/child/package.json"
  if [[ "$scenario" == scoped-unresolved ]]; then
    rm "$fixture/checkout/node_modules/parent/node_modules/child/package.json"
  fi
  set +e
  PATH="$fixture/bin:$PATH" SCANNER_STATUS=1 CVE_TEST_STAGE=overrides \
    CVE_TEST_COMPLETE=true CVE_TEST_SCOPED_REPORT="$fixture/scoped-report.json" \
    OPENSESAME_AUDIT_DIR="$fixture/reports" \
    bash "$fixture/checkout/scripts/audit/cve-lite-gate.sh" \
    > "$fixture/cve-$scenario.log" 2>&1
  status=$?
  set -e
  if [[ "$scenario" == scoped-good ]]; then
    [[ "$status" -eq 0 ]]
    rg -q 'verified scoped floor: parent>child >= 2.4.0' "$fixture/cve-$scenario.log"
  else
    [[ "$status" -ne 0 ]]
    if rg -q 'gate: CLEAN' "$fixture/cve-$scenario.log"; then exit 1; fi
  fi
done
cp "$SOURCE_ROOT/scripts/lib/phantom-import-evidence.mjs" "$fixture/checkout/scripts/lib/"
ln -s "$SOURCE_ROOT/node_modules/typescript" "$fixture/checkout/node_modules/typescript"
mkdir -p "$fixture/checkout/apps/demo/src"
printf '%s\n' '{"devDependencies":{"fixture-child":"1.0.0"}}' \
  > "$fixture/checkout/apps/demo/package.json"
printf '%s\n' 'import value from "fixture-child";' > "$fixture/outside.mjs"
for scenario in root-declared root-undeclared root-outside root-literal root-unknown root-missing workspace-declared root-truncated; do
  file=scripts/lib/import-fixture.mjs
  declaration='{}'
  [[ "$scenario" == root-declared ]] && declaration='{"devDependencies":{"fixture-child":"1.0.0"}}'
  printf '%s\n' "$declaration" > "$fixture/checkout/package.json"
  printf '%s\n' 'import value from "fixture-child";' > "$fixture/checkout/$file"
  if [[ "$scenario" == root-outside ]]; then file="$fixture/outside.mjs"; fi
  if [[ "$scenario" == root-literal ]]; then
    printf '%s\n' "const fixture = 'import value from \"fixture-child\";';" > "$fixture/checkout/$file"
  fi
  if [[ "$scenario" == root-truncated ]]; then
    printf '%s\n' "const fixture = 'import value from \"fixture-child\";';" > "$fixture/checkout/$file"
    file="$file (+1 more)"
  fi
  if [[ "$scenario" == root-unknown ]]; then
    printf '%s\n' 'const name = "fixture-child";' > "$fixture/checkout/$file"
  fi
  if [[ "$scenario" == root-missing ]]; then rm "$fixture/checkout/$file"; fi
  if [[ "$scenario" == workspace-declared ]]; then
    file=apps/demo/src/source.mjs
    printf '%s\n' 'const value = await import("fixture-child");' > "$fixture/checkout/$file"
  fi
  printf '{"findings":[{"ruleId":"PD002","package":{"name":"fixture-child"},"details":"Imported in: %s. If the parent package changes this dependency, code breaks."}],"skippedOverrideRules":[]}\n' \
    "$file" > "$fixture/phantom-report.json"
  set +e
  PATH="$fixture/bin:$PATH" SCANNER_STATUS=1 CVE_TEST_STAGE=overrides \
    CVE_TEST_COMPLETE=true CVE_TEST_SCOPED_REPORT="$fixture/phantom-report.json" \
    OPENSESAME_AUDIT_DIR="$fixture/reports" \
    bash "$fixture/checkout/scripts/audit/cve-lite-gate.sh" \
    > "$fixture/cve-$scenario.log" 2>&1
  status=$?
  set -e
  if [[ "$scenario" == root-declared || "$scenario" == root-literal || "$scenario" == workspace-declared ]]; then
    [[ "$status" -eq 0 ]]
    rg -q 'gate: CLEAN' "$fixture/cve-$scenario.log"
  else
    [[ "$status" -ne 0 ]]
    if rg -q 'gate: CLEAN' "$fixture/cve-$scenario.log"; then exit 1; fi
  fi
done
printf '%s\n' 'scanner status gates contract: 28 cases passed'
