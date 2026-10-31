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
[[ "$BIN" != *$'\n'* && "$BIN" != *$'\r'* ]] || { echo "invalid scanner path" >&2; exit 1; }
# Execute the same file the checksum names, including relative path overrides.
BIN="$(realpath -m -- "$BIN")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid scanner version" >&2; exit 1; }
OSV_ARCH="$(uname -m)"
case "$OSV_ARCH" in
  x86_64|amd64) OSV_ARCH="amd64" ;;
  aarch64|arm64) OSV_ARCH="arm64" ;;
  *) echo "unsupported arch for osv-scanner download: $OSV_ARCH" >&2; exit 1 ;;
esac

# Reviewed release pins: both osv-scanner_SHA256SUMS and multiple.intoto.jsonl
# at https://github.com/google/osv-scanner/releases/tag/v2.5.0 identify these
# Linux binaries. The SLSA source is a258868211a57052da6bd323f758b8388dee02bb.
# A different version needs an explicit digest; an explicitly empty override
# must fail rather than silently selecting a built-in pin.
DEFAULT_SHA256=""
case "$VERSION:$OSV_ARCH" in
  2.5.0:amd64) DEFAULT_SHA256="edcfc41d257db36148f065055655fe3fcfc434b0b423ea67468a84c207524e0c" ;;
  2.5.0:arm64) DEFAULT_SHA256="fe152e1a546af223e6c557cc3111a8bb3e5dc02fcbf7dbe95d26567c0f0041f2" ;;
esac
EXPECTED_SHA256="${OPENSESAME_OSV_SCANNER_SHA256-$DEFAULT_SHA256}"
[[ -n "$EXPECTED_SHA256" ]] || { echo "missing scanner digest (set OPENSESAME_OSV_SCANNER_SHA256 for an unpinned version)" >&2; exit 1; }
[[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid scanner digest" >&2; exit 1; }

verify_osv_scanner() {
  printf '%s  %s\n' "$EXPECTED_SHA256" "$BIN" | sha256sum --check --status || {
    echo "osv-scanner gate: FAIL (scanner digest mismatch)" >&2; exit 1;
  }
}

ensure_osv_scanner() {
  local downloaded=false url
  if [[ ! -x "$BIN" ]]; then
    [[ -z "${OPENSESAME_OSV_SCANNER_BIN:-}" ]] || {
      echo "osv-scanner gate: FAIL (configured scanner is missing or not executable)" >&2; exit 1;
    }
    url="https://github.com/google/osv-scanner/releases/download/v${VERSION}/osv-scanner_linux_${OSV_ARCH}"
    echo "==> downloading osv-scanner v${VERSION} (${OSV_ARCH})"
    curl -fsSL -o "$BIN" "$url"
    downloaded=true
  fi
  # Cached, downloaded and caller-supplied binaries all pass the same check
  # before even --version is executed. Never overwrite a caller's binary.
  verify_osv_scanner
  if [[ "$downloaded" == true ]]; then chmod +x "$BIN"; fi
  "$BIN" --version 2>/dev/null | grep -Eq "(^|[[:space:]])${VERSION//./\\.}([[:space:]]|$)" || {
    echo "osv-scanner gate: FAIL (scanner version mismatch)" >&2; exit 1;
  }
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
