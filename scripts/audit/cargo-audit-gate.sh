#!/usr/bin/env bash
# cargo-audit gate — fails on any RustSec vulnerability in Cargo.lock.
# Complements cargo-deny (licenses/sources/advisories) with the dedicated audit CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory

TOOLCHAIN="${OPENSESAME_RUST_TOOLCHAIN:-1.88.0}"

if ! cargo "+${TOOLCHAIN}" audit -V >/dev/null 2>&1; then
  echo "==> installing cargo-audit for toolchain ${TOOLCHAIN}"
  cargo "+${TOOLCHAIN}" install cargo-audit --locked
fi

echo "==> cargo +${TOOLCHAIN} audit"
set +e
cargo "+${TOOLCHAIN}" audit --json >"$OPENSESAME_AUDIT_DIR/cargo-audit.json"
audit_status=$?
set -e

CARGO_AUDIT_STATUS="$audit_status" python3 - <<'PY'
import json, os
import sys
from pathlib import Path

path = Path(os.environ["OPENSESAME_AUDIT_DIR"]) / "cargo-audit.json"
if not path.exists() or path.stat().st_size == 0:
    print("cargo-audit gate: FAIL (missing JSON report)", file=sys.stderr)
    sys.exit(1)
data = json.loads(path.read_text())
vulns = data.get("vulnerabilities") if isinstance(data, dict) else None
if not isinstance(vulns, dict):
    sys.exit("cargo-audit gate: FAIL (missing vulnerabilities object)")
count = vulns.get("count")
lst = vulns.get("list")
if type(count) is not int or count < 0 or not isinstance(lst, list) or count != len(lst):
    sys.exit("cargo-audit gate: FAIL (inconsistent vulnerability report)")
if type(vulns.get("found")) is not bool or vulns["found"] != (count > 0):
    sys.exit("cargo-audit gate: FAIL (inconsistent found flag)")
if count:
    print(f"cargo-audit gate: FAIL ({count} vulnerabilities)", file=sys.stderr)
    for v in lst:
        adv = v.get("advisory") or {}
        pkg = v.get("package") or {}
        print(
            f"  {adv.get('id')}: {pkg.get('name')}@{pkg.get('version')} — {adv.get('title', '')}",
            file=sys.stderr,
        )
    sys.exit(1)
if os.environ["CARGO_AUDIT_STATUS"] != "0":
    sys.exit("cargo-audit gate: FAIL (scanner failed without a complete clean result)")
print("cargo-audit gate: CLEAN (0 vulnerabilities)")
PY
