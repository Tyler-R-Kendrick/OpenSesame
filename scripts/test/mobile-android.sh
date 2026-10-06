#!/usr/bin/env bash
# Real JVM crypto/FFI tests and an Android application compile; no silent skips.
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"
ffi_dir="${OPENSESAME_NATIVE_FFI_DIR:-${CARGO_TARGET_DIR:-$repo_root/target}/debug}"
if [[ -z "${OPENSESAME_NATIVE_FFI_DIR:-}" ]]; then
  cargo +1.88.0 build -p opensesame-authenticator-core --features ffi
fi
case "$(uname -s)" in
  Darwin) ffi_library="$ffi_dir/libopensesame_authenticator_core.dylib" ;;
  *) ffi_library="$ffi_dir/libopensesame_authenticator_core.so" ;;
esac
[[ -f "$ffi_library" ]] || { echo "missing native FFI library: $ffi_library" >&2; exit 1; }
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djna.library.path=\"$ffi_dir\""
cd apps/android/android
"${GRADLE_BIN:-gradle}" --no-daemon --max-workers=2 \
  :app:testDebugUnitTest :app:assembleDebug \
  -PopensesameWalletBackendUrl=https://identity.example
