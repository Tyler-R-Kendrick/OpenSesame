#!/usr/bin/env bash
set -euo pipefail
native_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$native_root/../.." && pwd)"
native_target="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"
export CARGO_TARGET_DIR="$native_target"
export OPENSESAME_BINDGEN_TARGET_DIR="$native_target"
export OPENSESAME_BINDGEN_CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
cd "$repo_root"
export OPENSESAME_NATIVE_REPORT_DIR="${OPENSESAME_NATIVE_REPORT_DIR:-$native_target/native-reports}"
mkdir -p "$OPENSESAME_NATIVE_REPORT_DIR"
run_rust() {
  local group="$1"
  shift
  CARGO_TERM_COLOR=never cargo +1.88.0 "$@" 2>&1 | tee "$OPENSESAME_NATIVE_REPORT_DIR/$group.log"
  python3 "$native_root/scripts/verify-native-results.py" rust \
    "$OPENSESAME_NATIVE_REPORT_DIR/$group.log" --group "$group" \
    > "$OPENSESAME_NATIVE_REPORT_DIR/$group-verified.json"
}

case "${1:-}" in
  core)
    run_rust authenticator test --locked -p opensesame-authenticator-core --features ffi --lib
    run_rust authenticator-otp-conformance test --locked -p opensesame-authenticator-core --features ffi --test otp_conformance
    run_rust otp test --locked -p opensesame-human-vault otp::
    run_rust retired test --locked -p opensesame-human-vault retired_credentials::
    run_rust canaries test --locked -p opensesame-human-vault credential_canaries::
    ;;
  android)
    command -v gradle >/dev/null || { echo "Gradle 8.13 is required" >&2; exit 1; }
    bash "$native_root/scripts/build-core.sh" android
    export OPENSESAME_NATIVE_HOST_LIBRARY_DIR="$native_target/debug"
    cd "$native_root/android"
    gradle --no-daemon --max-workers=4 :app:compileDebugKotlin :app:testDebugUnitTest :app:assembleDebug \
      2>&1 | tee "$OPENSESAME_NATIVE_REPORT_DIR/android-gradle.log"
    python3 "$native_root/scripts/verify-native-results.py" jvm app/build/test-results/testDebugUnitTest \
      > "$OPENSESAME_NATIVE_REPORT_DIR/android-jvm-verified.json"
    mkdir -p "$OPENSESAME_NATIVE_REPORT_DIR/android-jvm"
    cp app/build/test-results/testDebugUnitTest/TEST-*.xml "$OPENSESAME_NATIVE_REPORT_DIR/android-jvm/"
    python3 "$native_root/scripts/verify-android-package.py" app/build/outputs/apk/debug/app-debug.apk
    ;;
  swift)
    command -v swiftc >/dev/null || { echo "Swift 6.2 is required" >&2; exit 1; }
    bash "$native_root/scripts/build-core.sh" bindings
    native_temp="$(mktemp -d)"
    trap 'rm -rf "$native_temp"' EXIT
    native_module_cache="${OPENSESAME_SWIFT_MODULE_CACHE:-${TMPDIR:-/tmp}/opensesame-native-swift-modules}"
    swiftc -module-cache-path "$native_module_cache" \
      "$native_root/ios/Sources/OpenSesameAuthenticator/NativeAuthorityFence.swift" \
      "$native_root/ios/Sources/OpenSesameAuthenticator/NativeRealmState.swift" \
      "$native_root/test/native-realm-behavior.swift" -o "$native_temp/realm"
    "$native_temp/realm" 2>&1 | tee "$OPENSESAME_NATIVE_REPORT_DIR/swift-realm.log"
    swiftc -module-cache-path "$native_module_cache" \
      -I "$native_root/ios/Sources/OpenSesameAuthenticatorCore" \
      -Xcc "-fmodule-map-file=$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_coreFFI.modulemap" \
      "$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_core.swift" \
      "$native_root/test/native-ffi-behavior.swift" \
      -L "$native_target/debug" -lopensesame_authenticator_core -o "$native_temp/ffi"
    LD_LIBRARY_PATH="$native_target/debug${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      DYLD_LIBRARY_PATH="$native_target/debug${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" "$native_temp/ffi" 2>&1 | tee "$OPENSESAME_NATIVE_REPORT_DIR/swift-ffi.log"
    native_swift_library="$native_temp/libOpenSesameAuthenticatorCore.so"
    if [[ "$(uname -s)" == Darwin ]]; then native_swift_library="$native_temp/libOpenSesameAuthenticatorCore.dylib"; fi
    swiftc -module-cache-path "$native_module_cache" -emit-library -emit-module \
      -module-name OpenSesameAuthenticatorCore -emit-module-path "$native_temp/OpenSesameAuthenticatorCore.swiftmodule" \
      -I "$native_root/ios/Sources/OpenSesameAuthenticatorCore" \
      -Xcc "-fmodule-map-file=$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_coreFFI.modulemap" \
      "$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_core.swift" \
      -L "$native_target/debug" -lopensesame_authenticator_core -o "$native_swift_library"
    swiftc -module-cache-path "$native_module_cache" -I "$native_temp" \
      -I "$native_root/ios/Sources/OpenSesameAuthenticatorCore" \
      -Xcc "-fmodule-map-file=$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_coreFFI.modulemap" \
      "$native_root/ios/Sources/OpenSesameAuthenticator/NativeIssuerGuard.swift" \
      "$native_root/ios/Sources/OpenSesameAuthenticator/NativeCanaryExport.swift" \
      "$native_root/test/native-canary-behavior.swift" \
      -L "$native_temp" -lOpenSesameAuthenticatorCore \
      -L "$native_target/debug" -lopensesame_authenticator_core -o "$native_temp/canary"
    LD_LIBRARY_PATH="$native_temp:$native_target/debug${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
      DYLD_LIBRARY_PATH="$native_temp:$native_target/debug${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}" \
      "$native_temp/canary" "$repo_root/packages/app-core/src/lib/credential-observation/protocol-vectors.json" 2>&1 | tee "$OPENSESAME_NATIVE_REPORT_DIR/swift-canary.log"
    python3 "$native_root/scripts/verify-native-results.py" swift "$OPENSESAME_NATIVE_REPORT_DIR" \
      > "$OPENSESAME_NATIVE_REPORT_DIR/swift-verified.json"
    ;;
  *) echo "usage: $0 core|android|swift" >&2; exit 2 ;;
esac
