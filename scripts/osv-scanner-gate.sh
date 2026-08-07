#!/usr/bin/env bash
# OSV-Scanner gate — fails on any non-ignored vulnerability in lockfiles.
# Complements cargo-deny (RustSec) and cve-lite (npm-focused OSV) with Google OSV.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/security .tools/bin

VERSION="${OPENSESAME_OSV_SCANNER_VERSION:-2.5.0}"
BIN="$ROOT/.tools/bin/osv-scanner"

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
  --output-file artifacts/security/osv-scanner.json \
  2>artifacts/security/osv-scanner.err
status=$?
set -e

python3 - <<'PY'
import json, sys
from pathlib import Path

path = Path("artifacts/security/osv-scanner.json")
if not path.exists() or path.stat().st_size == 0:
    err = Path("artifacts/security/osv-scanner.err").read_text(errors="replace")
    print("osv-scanner gate: FAIL (no JSON output)", file=sys.stderr)
    print(err, file=sys.stderr)
    sys.exit(1)

data = json.loads(path.read_text())
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

if findings:
    print(f"osv-scanner gate: FAIL ({len(findings)} vulnerabilities)", file=sys.stderr)
    for f in findings:
        print(
            f"  {f['id']}: {f['ecosystem']} {f['package']}@{f['version']} — {f['summary']}",
            file=sys.stderr,
        )
    sys.exit(1)

print("osv-scanner gate: CLEAN (0 vulnerabilities after ignores)")
sys.exit(0)
PY
