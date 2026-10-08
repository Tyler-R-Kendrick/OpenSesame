#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 signed-release.apk expected-certificate-sha256" >&2; exit 2; }
release_apk="$1"
release_certificate="$2"
native_root="$(cd "$(dirname "$0")/.." && pwd)"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[[ -n "$sdk_root" ]] || { echo "ANDROID_HOME is required" >&2; exit 1; }
python3 "$native_root/scripts/verify-android-package.py" "$release_apk"
release_signature="$(mktemp)"
release_manifest="$(mktemp)"
trap 'rm -f "$release_signature" "$release_manifest"' EXIT
"$sdk_root/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$release_apk" > "$release_signature"
"$sdk_root/build-tools/36.0.0/aapt2" dump badging "$release_apk" > "$release_manifest"
python3 - "$release_signature" "$release_manifest" "$release_certificate" <<'PY'
import pathlib,re,sys
signature=pathlib.Path(sys.argv[1]).read_text()
manifest=pathlib.Path(sys.argv[2]).read_text()
expected=sys.argv[3].replace(":", "").lower()
actual=re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]+)$",signature,re.M)
if not re.fullmatch(r"[a-f0-9]{64}",expected) or [value.lower() for value in actual] != [expected]:
    sys.exit("APK signer does not match the registered production certificate")
if "CN=Android Debug" in signature or "application-debuggable" in manifest:
    sys.exit("Debug signing or a debuggable APK is forbidden for distribution")
if not re.search(r"^package: name='dev\.opensesame\.authenticator'",manifest,re.M):
    sys.exit("Unexpected Android application identity")
print("Signed production APK identity, non-debug policy and native packaging verified")
PY
