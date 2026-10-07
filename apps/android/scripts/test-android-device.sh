#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 app.apk tests.apk expected-page-size" >&2; exit 2; }
device_apk="$1"
device_tests="$2"
device_pages="$3"
[[ "$device_pages" == 4096 || "$device_pages" == 16384 ]] || exit 2
visual_source="$(git rev-parse HEAD)"
[[ "$visual_source" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ -z "${GITHUB_SHA:-}" || "$GITHUB_SHA" == "$visual_source" ]] || exit 2
visual_application="$(sha256sum "$device_apk" | cut -d ' ' -f 1)"
visual_run="visual-${visual_source:0:12}-$device_pages-$$"
actual_pages="$(adb shell getconf PAGE_SIZE | tr -d '\r')"
[[ "$actual_pages" == "$device_pages" ]] || { echo "Expected $device_pages byte device pages; got $actual_pages" >&2; exit 1; }
# Disposable CI emulator only. Tests exercise the real OS credential screen,
# including a rejected cancellation and a successful PIN entry.
adb shell locksettings set-pin 123456
adb shell input keyevent 82
adb install -r "$device_apk"
adb install -r "$device_tests"
device_report_dir="${OPENSESAME_NATIVE_REPORT_DIR:-native-device-results/$device_pages}"
mkdir -p "$device_report_dir"
device_visual_dir="$device_report_dir/visual/$visual_run"
[[ ! -e "$device_visual_dir" ]] || exit 2
mkdir -p "$device_visual_dir"
collect_device_visual() {
  local checkpoint suffix temporary
  for checkpoint in security-empty enrollment-default reject-enrolled synthetic-enrolled reject-result synthetic-realm fresh-owner revoked revoked-rejected; do
    for suffix in png json; do
      temporary="$device_visual_dir/$checkpoint.$suffix.partial"
      if adb exec-out run-as dev.opensesame.authenticator cat "files/native-visual/$visual_run/$checkpoint.$suffix" > "$temporary" 2>/dev/null && [[ -s "$temporary" ]]; then
        mv "$temporary" "$device_visual_dir/$checkpoint.$suffix"
      else
        rm -f "$temporary"
      fi
    done
  done
}
trap 'device_status=$?; collect_device_visual || true; exit "$device_status"' EXIT
device_output="$device_report_dir/instrumentation.log"
printf '%s\n' "$actual_pages" > "$device_report_dir/page-size.txt"
adb shell am instrument -w -r \
  -e visualSourceSha "$visual_source" -e visualRunId "$visual_run" -e visualPages "$actual_pages" \
  -e class dev.opensesame.authenticator.NativeAdmissionDeviceTest,dev.opensesame.authenticator.NativeSettingsDeviceJourneyTest,dev.opensesame.authenticator.NativeCanaryDeviceTest \
  dev.opensesame.authenticator.test/androidx.test.runner.AndroidJUnitRunner | tee "$device_output"
collect_device_visual
python3 "$(dirname "$0")/verify-native-results.py" android "$device_output" --pages "$device_pages" \
  > "$device_report_dir/verified.json"
cat "$device_report_dir/verified.json"
python3 "$(dirname "$0")/verify-native-visual.py" android "$device_visual_dir" \
  --source "$visual_source" --application "$visual_application" --pages "$actual_pages" \
  --admission "$device_report_dir/verified.json" > "$device_report_dir/visual/$visual_run-verified.json"
trap - EXIT
