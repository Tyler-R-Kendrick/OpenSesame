#!/usr/bin/env bash
# OSV-Scanner gate — fails on every vulnerability reported by the scanner.
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
  local installed_version
  if [[ -x "$BIN" ]] && installed_version="$("$BIN" --version 2>/dev/null)" &&
     [[ "$installed_version" == *"$VERSION"* ]]; then
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

# Enumerate tracked inputs so hidden tooling workspaces and independent Rust/Go
# modules are scanned too, without walking node_modules or private audit output.
# go.mod is the scanner's dependency input; go.sum also contains stale downloads.
git ls-files -z > "$OPENSESAME_AUDIT_DIR/tracked-files"
lockfiles=()
while IFS= read -r -d '' file; do
  case "${file##*/}" in
    Cargo.lock|pnpm-lock.yaml|go.mod|package-lock.json|npm-shrinkwrap.json|yarn.lock)
      lockfiles+=("--lockfile=$file") ;;
  esac
done < "$OPENSESAME_AUDIT_DIR/tracked-files"
if [[ "${#lockfiles[@]}" -eq 0 ]]; then
  echo "osv-scanner gate: FAIL (no tracked dependency inputs)" >&2
  exit 1
fi

# The separately pinned native compiler contributes a Go standard library that
# is not represented by an application go.mod or go.sum.
sbomfiles=()
native_plan="tools/pwa-tailscale-native-http/source.json"
if [[ -f "$native_plan" ]] || git ls-files --error-unmatch "$native_plan" >/dev/null 2>&1; then
  native_sbom="$OPENSESAME_AUDIT_DIR/native-toolchain.cdx.json"
  python3 scripts/audit/native-toolchain-sbom.py "$native_plan" "$native_sbom"
  sbomfiles+=("--sbom=$native_sbom")
  # Module-only scanners cannot distinguish unimported upstream tools/OpenPGP
  # from the exact composed JS/WASM package graph. Audit that graph as well.
  node tools/pwa-tailscale-native-http/native-audit.mjs
fi

# Local source replacements are omitted by module-version scanners. Validate
# the retained upstream bytes and scan every imported crypto package separately.
if [[ -f scripts/test/live-turn/go.mod ]]; then
  bash scripts/test/live-turn/audit-crypto.sh
fi

echo "==> osv-scanner scan (lockfiles)"
set +e
"$BIN" scan source \
  "${lockfiles[@]}" \
  "${sbomfiles[@]}" \
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
node scripts/security/assert-no-advisories.mjs "$OPENSESAME_AUDIT_DIR/osv-findings.json"
