#!/usr/bin/env bash
# cargo-audit gate — fails on any RustSec vulnerability in Cargo.lock.
# Complements cargo-deny (licenses/sources/advisories) with the dedicated audit CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/security

TOOLCHAIN="${OPENSESAME_RUST_TOOLCHAIN:-1.88.0}"

if ! cargo "+${TOOLCHAIN}" audit -V >/dev/null 2>&1; then
  echo "==> installing cargo-audit for toolchain ${TOOLCHAIN}"
  cargo "+${TOOLCHAIN}" install cargo-audit --locked
fi

echo "==> cargo +${TOOLCHAIN} audit"
set +e
cargo "+${TOOLCHAIN}" audit --json >artifacts/security/cargo-audit.json
cargo "+${TOOLCHAIN}" audit 2>&1 | tee artifacts/security/cargo-audit.txt
set -e

python3 - <<'PY'
import json
import sys
from pathlib import Path

path = Path("artifacts/security/cargo-audit.json")
if not path.exists() or path.stat().st_size == 0:
    print("cargo-audit gate: FAIL (missing JSON report)", file=sys.stderr)
    sys.exit(1)
data = json.loads(path.read_text())
vulns = data.get("vulnerabilities") or {}
count = vulns.get("count") if isinstance(vulns, dict) else len(vulns or [])
lst = (vulns.get("list") if isinstance(vulns, dict) else vulns) or []
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
print("cargo-audit gate: CLEAN (0 vulnerabilities)")
PY
