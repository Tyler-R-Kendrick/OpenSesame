#!/usr/bin/env bash
# Package crypto tests run on Linux or macOS; platform adapters require Xcode.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
case "${1:-core}" in
  core|ios) ;;
  *) echo "usage: $0 [core|ios]" >&2; exit 2 ;;
esac
swift test --package-path apps/android/ios/EnvelopeCore
if [[ "${1:-}" == "ios" ]]; then
  [[ "$(uname -s)" == Darwin ]] || { echo "iOS compile requires macOS and Xcode" >&2; exit 1; }
  apps/android/scripts/build-core.sh ios
  sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
  swift build --package-path apps/android/ios \
    --triple "$(uname -m)-apple-ios26.0-simulator" --sdk "$sdk" --build-tests
  simulator="$(xcrun simctl list devices available --json | python3 -c '
import json, sys
for runtime, devices in json.load(sys.stdin)["devices"].items():
    if "SimRuntime.iOS-26" in runtime:
        for device in devices:
            if device["name"].startswith("iPhone"):
                print(device["udid"]); sys.exit(0)
raise SystemExit("an available iOS 26 iPhone simulator is required")
')"
  result_root="${OPENSESAME_IOS_RESULT_DIR:-${RUNNER_TEMP:-$repo_root/work}/mobile-ios}"
  mkdir -p "$result_root"
  cd apps/android/ios
  xcodebuild -list -json > "$result_root/schemes.json"
  scheme="$(python3 - "$result_root/schemes.json" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    data = json.load(file)
schemes = set()
for container in data.values():
    if isinstance(container, dict):
        schemes.update(container.get("schemes", []))
for candidate in ["OpenSesameAuthenticator-Package", "WalletEnvelopeStorage", "OpenSesameAuthenticator"]:
    if candidate in schemes:
        print(candidate); sys.exit(0)
raise SystemExit("no iOS package scheme available for the storage XCTest target")
PY
)"
  xcodebuild test -scheme "$scheme" -only-testing:WalletEnvelopeStorageTests \
    -destination "platform=iOS Simulator,id=$simulator" \
    -derivedDataPath "$result_root/DerivedData" \
    -resultBundlePath "$result_root/tests.xcresult" CODE_SIGNING_ALLOWED=NO
  xcrun xcresulttool get test-results summary --path "$result_root/tests.xcresult" \
    > "$result_root/summary.json"
  python3 - "$result_root/summary.json" <<'PY'
import json, sys
with open(sys.argv[1]) as file:
    summary = json.load(file)
if summary.get("passedTests", 0) < 4 or summary.get("failedTests", 0) != 0:
    raise SystemExit("the real iOS storage XCTest suite did not pass")
print("iOS simulator XCTest summary:", summary["passedTests"], "passed")
PY
fi
