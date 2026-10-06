#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 app.apk tests.apk expected-page-size" >&2; exit 2; }
device_apk="$1"
device_tests="$2"
device_pages="$3"
[[ "$device_pages" == 4096 || "$device_pages" == 16384 ]] || exit 2
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
device_output="$device_report_dir/instrumentation.log"
printf '%s\n' "$actual_pages" > "$device_report_dir/page-size.txt"
adb shell am instrument -w -r \
  -e class dev.opensesame.authenticator.NativeAdmissionDeviceTest,dev.opensesame.authenticator.NativeSettingsDeviceJourneyTest,dev.opensesame.authenticator.NativeCanaryDeviceTest \
  dev.opensesame.authenticator.test/androidx.test.runner.AndroidJUnitRunner | tee "$device_output"
python3 "$(dirname "$0")/verify-native-results.py" android "$device_output" --pages "$device_pages" \
  > "$device_report_dir/verified.json"
cat "$device_report_dir/verified.json"
