#!/usr/bin/env bash
set -euo pipefail
native_root="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$(uname -s)" == Darwin ]] || { echo "Apple SDK validation requires macOS" >&2; exit 1; }
command -v xcodegen >/dev/null || { echo "XcodeGen 2.44.1 is required" >&2; exit 1; }
xcode_version="$(xcodebuild -version | awk '/^Xcode / { print $2 }')"
[[ "${xcode_version%%.*}" -ge 26 ]] || { echo "Xcode 26+ is required" >&2; exit 1; }
export IPHONEOS_DEPLOYMENT_TARGET=26.0
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"
apple_output="${OPENSESAME_APPLE_VALIDATION_OUTPUT:-$CARGO_TARGET_DIR/native-apple-validation}"
mkdir -p "$apple_output"
bash "$native_root/scripts/build-core.sh" ios
xcodegen generate --spec "$native_root/ios/project.yml" --project "$native_root/ios"
# These are unsigned validation builds. Distribution requires the operator's
# registered team, matching entitlements, production backend and signing inputs.
xcodebuild -project "$native_root/ios/OpenSesameNative.xcodeproj" -scheme OpenSesameNative \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath "$apple_output/DerivedData" \
  CODE_SIGNING_ALLOWED=NO OPENSESAME_WALLET_BACKEND_URL=https://wallet-validation.example.invalid build
apple_device="$(xcrun simctl list devices available --json | python3 -c '
import json,sys
data=json.load(sys.stdin)
for runtime,devices in data["devices"].items():
    if ".iOS-" not in runtime: continue
    version=runtime.rsplit(".iOS-",1)[1].split("-")[0]
    if not version.isdigit() or int(version)<26: continue
    for device in devices:
        if device.get("isAvailable") and device["name"].startswith("iPhone") and "SE" not in device["name"]:
            print(device["udid"]);sys.exit(0)
sys.exit("An available iOS 26+ iPhone simulator is required")
')"
python3 "$native_root/test/apple-results-test.py"
python3 "$native_root/test/apple-sensor-test.py"
apple_clone=""
apple_sensor_pid=""
cleanup_apple_phase() {
  if [[ -n "$apple_sensor_pid" ]]; then
    kill "$apple_sensor_pid" 2>/dev/null || true
    wait "$apple_sensor_pid" 2>/dev/null || true
    apple_sensor_pid=""
  fi
  if [[ -n "$apple_clone" ]]; then
    xcrun simctl shutdown "$apple_clone" || true
    xcrun simctl delete "$apple_clone"
    apple_clone=""
  fi
}
trap cleanup_apple_phase EXIT
run_apple_phase() {
  local phase="$1"
  local sensor_url=""
  local sensor_port="$apple_output/sensor-$phase-$$.port"
  local result="$apple_output/NativeAdmission-$phase-$(date +%s)-$$.xcresult"
  local selectors=()
  apple_clone="$(xcrun simctl clone "$apple_device" "OpenSesame-native-$phase-$$")"
  xcrun simctl boot "$apple_clone"
  xcrun simctl bootstatus "$apple_clone" -b
  if [[ "$phase" == cold ]]; then
    python3 "$native_root/scripts/apple-biometric-fixture.py" configure "$apple_clone" 0
    selectors=(-only-testing:NativeAdmissionTests
      -only-testing:NativeAdmissionUITests/NativeAdmissionUITests/testColdLaunchAndUnavailableOwnerAuthenticationNeverExposeProductionUi)
  else
    python3 "$native_root/scripts/apple-biometric-fixture.py" configure "$apple_clone" 1
    python3 "$native_root/scripts/apple-biometric-fixture.py" serve "$apple_clone" "$sensor_port" \
      > "$apple_output/sensor-$phase.log" 2>&1 &
    apple_sensor_pid=$!
    for _ in {1..50}; do
      [[ -s "$sensor_port" ]] && break
      kill -0 "$apple_sensor_pid"
      sleep 0.1
    done
    [[ -s "$sensor_port" ]] || { echo "Simulator sensor fixture unavailable" >&2; return 1; }
    sensor_url="http://127.0.0.1:$(cat "$sensor_port")"
    if [[ "$phase" == password ]]; then
      selectors=(-only-testing:NativeAdmissionUITests/NativeOwnerJourneyUITests/testVisibleOwnerRetiredPasswordLifecycle)
    else
      selectors=(-only-testing:NativeAdmissionUITests/NativeOwnerJourneyUITests/testVisibleFreshOwnerControlledCanaryLifecycle)
    fi
  fi
  # Only the XCTest bundle receives this sensor-control URL. The production app has no
  # fixture endpoint, injected grant, test credential or relaxed transport setting.
  xcodebuild -project "$native_root/ios/OpenSesameNative.xcodeproj" -scheme OpenSesameNative \
    -sdk iphonesimulator -destination "id=$apple_clone" -derivedDataPath "$apple_output/DerivedData" \
    -resultBundlePath "$result" "${selectors[@]}" \
    CODE_SIGNING_ALLOWED=NO OPENSESAME_WALLET_BACKEND_URL=https://wallet-validation.example.invalid \
    "OPENSESAME_TEST_BIOMETRIC_HELPER_URL=$sensor_url" test
  xcrun xcresulttool get test-results summary --path "$result" --format json > "$result-summary.json"
  xcrun xcresulttool get test-results tests --path "$result" --format json > "$result-tests.json"
  python3 "$native_root/scripts/verify-apple-results.py" "$result-summary.json" "$result-tests.json" "$phase" \
    > "$result-verified.json"
  cleanup_apple_phase
}
run_apple_phase cold
run_apple_phase password
run_apple_phase canary
