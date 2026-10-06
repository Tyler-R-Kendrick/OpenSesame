#!/usr/bin/env bash
# OSV-Scanner gate — fails on unresolved vulnerabilities; verifies exact local source backports.
# Complements cargo-deny (RustSec) and cve-lite (npm-focused OSV) with Google OSV.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
mkdir -p .tools/bin

VERSION="${OPENSESAME_OSV_SCANNER_VERSION:-2.5.0}"
BIN="${OPENSESAME_OSV_SCANNER_BIN:-$ROOT/.tools/bin/osv-scanner}"

ensure_osv_scanner() {
  if [[ -x "$BIN" ]] && "$BIN" --version 2>/dev/null | grep -q "$VERSION"; then
    return 0
  fi
  local arch url
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "unsupported arch for osv-scanner download: $arch" >&2
      exit 1
      ;;
  esac
  url="https://github.com/google/osv-scanner/releases/download/v${VERSION}/osv-scanner_linux_${arch}"
  echo "==> downloading osv-scanner v${VERSION} (${arch})"
  curl -fsSL -o "$BIN" "$url"
  chmod +x "$BIN"
}

ensure_osv_scanner

echo "==> osv-scanner scan (lockfiles)"
set +e
"$BIN" scan source \
  --lockfile=Cargo.lock \
  --lockfile=pnpm-lock.yaml \
  --config="$ROOT/osv-scanner.toml" \
  --format json \
  --output-file "$OPENSESAME_AUDIT_DIR/osv-scanner.json" \
  2>"$OPENSESAME_AUDIT_DIR/osv-scanner.err"
status=$?
set -e
if [[ "$status" -gt 1 ]]; then
  echo "osv-scanner gate: FAIL (scanner error $status)" >&2
  exit 1
fi

OSV_SCAN_STATUS="$status" python3 - <<'PY'
import json, os, sys
from pathlib import Path

path = Path(os.environ["OPENSESAME_AUDIT_DIR"]) / "osv-scanner.json"
if not path.exists() or path.stat().st_size == 0:
    err = (Path(os.environ["OPENSESAME_AUDIT_DIR"]) / "osv-scanner.err").read_text(errors="replace")
    print("osv-scanner gate: FAIL (no JSON output)", file=sys.stderr)
    print(err, file=sys.stderr)
    sys.exit(1)

data = json.loads(path.read_text())
if not isinstance(data.get("results"), list):
    print("osv-scanner gate: FAIL (invalid results)", file=sys.stderr)
    sys.exit(1)
findings = []
for result in data.get("results") or []:
    src = (result.get("source") or {}).get("path", "?")
    for pkg in result.get("packages") or []:
        meta = pkg.get("package") or {}
        name = meta.get("name")
        ver = meta.get("version")
        eco = meta.get("ecosystem")
        for vuln in pkg.get("vulnerabilities") or []:
            findings.append(
                {
                    "id": vuln.get("id"),
                    "ecosystem": eco,
                    "package": name,
                    "version": ver,
                    "source": src,
                    "summary": (vuln.get("summary") or "")[:160],
                }
            )

if os.environ["OSV_SCAN_STATUS"] == "1" and not findings:
    print("osv-scanner gate: FAIL (scanner findings omitted from report)", file=sys.stderr)
    sys.exit(1)
output = Path(os.environ["OPENSESAME_AUDIT_DIR"]) / "osv-findings.json"
output.write_text(json.dumps(findings))
PY
node scripts/security/verified-backports.mjs "$OPENSESAME_AUDIT_DIR/osv-findings.json"
