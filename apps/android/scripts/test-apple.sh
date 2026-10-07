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
apple_visual_source="$(git -C "$native_root" rev-parse HEAD)"
[[ "$apple_visual_source" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ -z "${GITHUB_SHA:-}" || "$GITHUB_SHA" == "$apple_visual_source" ]] || exit 2
apple_visual_attempt="$apple_output/visual-attempt-${apple_visual_source:0:12}-$$"
[[ ! -e "$apple_visual_attempt" ]] || exit 2
mkdir -p "$apple_visual_attempt/captures"
apple_visual_reports=()
apple_visual_exports=()
apple_visual_application=""
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
collect_apple_visual() {
  local phase="$1" result="$2" runner checkpoint suffix
  if [[ "$phase" != cold ]]; then
    # Preserve attachments even if the UI runner failed before writing its Documents copies.
    xcrun xcresulttool export attachments --help > "$apple_visual_attempt/attachments-$phase-help.txt" || return
    xcrun xcresulttool export attachments --path "$result" --output-path "$apple_visual_attempt/attachments-$phase" || return
    apple_visual_exports+=(--attachments "$apple_visual_attempt/attachments-$phase")
  fi
  local executable="$apple_output/DerivedData/Build/Products/Debug-iphonesimulator/OpenSesameNative.app/OpenSesameNative"
  [[ -f "$executable" ]] || return 1
  local actual_sha
  actual_sha="$(shasum -a 256 "$executable" | cut -d ' ' -f 1)" || return
  printf '%s\n' "$actual_sha" > "$apple_visual_attempt/application-$phase.sha256"
  [[ -z "$apple_visual_application" || "$apple_visual_application" == "$actual_sha" ]] || return 1
  apple_visual_application="$actual_sha"
  [[ "$phase" != cold ]] || return 0
  runner="$(xcrun simctl get_app_container "$apple_clone" dev.opensesame.authenticator.ui-tests.xctrunner data)" || return
  local checkpoints=(security-empty enrollment-default reject-enrolled synthetic-enrolled reject-result synthetic-realm fresh-owner revoked revoked-rejected)
  if [[ "$phase" == canary ]]; then checkpoints=(canary-created canary-revoked); fi
  for checkpoint in "${checkpoints[@]}"; do
    for suffix in png json; do
      if [[ -f "$runner/Documents/native-visual/$checkpoint.$suffix" ]]; then
        cp "$runner/Documents/native-visual/$checkpoint.$suffix" "$apple_visual_attempt/captures/$checkpoint.$suffix" || return
      fi
    done
  done
}
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
      -only-testing:NativeEnvelopeStorageTests -only-testing:NativeEnvelopeCoreTests
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
  local test_status=0 capture_status=0
  xcodebuild -project "$native_root/ios/OpenSesameNative.xcodeproj" -scheme OpenSesameNative \
    -sdk iphonesimulator -destination "id=$apple_clone" -derivedDataPath "$apple_output/DerivedData" \
    -resultBundlePath "$result" "${selectors[@]}" \
    CODE_SIGNING_ALLOWED=NO OPENSESAME_WALLET_BACKEND_URL=https://wallet-validation.example.invalid \
    "OPENSESAME_TEST_BIOMETRIC_HELPER_URL=$sensor_url" \
    "OPENSESAME_TEST_VISUAL_SOURCE_SHA=$apple_visual_source" test || test_status=$?
  collect_apple_visual "$phase" "$result" || capture_status=$?
  [[ "$test_status" == 0 ]] || return "$test_status"
  [[ "$capture_status" == 0 ]] || return "$capture_status"
  xcrun xcresulttool get test-results summary --path "$result" --format json > "$result-summary.json"
  xcrun xcresulttool get test-results tests --path "$result" --format json > "$result-tests.json"
  python3 "$native_root/scripts/verify-apple-results.py" "$result-summary.json" "$result-tests.json" "$phase" \
    > "$result-verified.json"
  apple_visual_reports+=(--admission "$result-verified.json")
  cleanup_apple_phase
}
run_apple_phase cold
run_apple_phase password
run_apple_phase canary
python3 "$native_root/scripts/verify-native-visual.py" apple "$apple_visual_attempt/captures" \
  --source "$apple_visual_source" --application "$apple_visual_application" \
  "${apple_visual_reports[@]}" "${apple_visual_exports[@]}" > "$apple_visual_attempt/visual-verified.json"
