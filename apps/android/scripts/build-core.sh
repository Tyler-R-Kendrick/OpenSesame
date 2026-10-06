#!/usr/bin/env bash
set -euo pipefail

native_root="$(cd "$(dirname "$0")/.." && pwd)"
repo_root="$(cd "$native_root/../.." && pwd)"
core_package="opensesame-authenticator-core"
library_name="opensesame_authenticator_core"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/packages/cargo-target}"

cd "$repo_root"

generate_bindings() {
  local bindgen_cargo_home="${OPENSESAME_BINDGEN_CARGO_HOME:-${CARGO_HOME:-$HOME/.cargo}}"
  local bindgen_target="${OPENSESAME_BINDGEN_TARGET_DIR:-$CARGO_TARGET_DIR}"
  CARGO_HOME="$bindgen_cargo_home" CARGO_TARGET_DIR="$bindgen_target" \
    cargo +1.88.0 build --locked -p "$core_package" --features ffi
  local host_library="$bindgen_target/debug/lib${library_name}"
  case "$(uname -s)" in
    Darwin) host_library="${host_library}.dylib" ;;
    Linux) host_library="${host_library}.so" ;;
    *) host_library="${host_library}.dll" ;;
  esac
  CARGO_HOME="$bindgen_cargo_home" CARGO_TARGET_DIR="$bindgen_target" \
    cargo +1.88.0 run --locked -p "$core_package" --features bindgen --bin uniffi-bindgen -- \
    generate "$host_library" --language kotlin \
    --out-dir "$native_root/generated/kotlin" --no-format
  CARGO_HOME="$bindgen_cargo_home" CARGO_TARGET_DIR="$bindgen_target" \
    cargo +1.88.0 run --locked -p "$core_package" --features bindgen --bin uniffi-bindgen -- \
    generate "$host_library" --language swift \
    --out-dir "$native_root/ios/Sources/OpenSesameAuthenticatorCore" --no-format
  # UniFFI's templates contain trailing whitespace and blank EOF lines. Keep
  # regeneration deterministic without requiring platform-specific formatters.
  while IFS= read -r generated; do
    local normalized
    normalized="$(mktemp)"
    awk 'NF { for (i = 0; i < blank; i++) print ""; blank = 0; sub(/[ \t]+$/, ""); print; next } { blank++ }' \
      "$generated" > "$normalized"
    cat "$normalized" > "$generated"
    rm "$normalized"
  done < <(find "$native_root/generated/kotlin" "$native_root/ios/Sources/OpenSesameAuthenticatorCore" \
    -type f \( -name '*.kt' -o -name '*.swift' -o -name '*.h' -o -name '*.modulemap' \))
}

case "${1:-}" in
  bindings)
    generate_bindings
    ;;
  android)
    command -v cargo-ndk >/dev/null || {
      echo "cargo-ndk is required: cargo +1.88.0 install cargo-ndk --version 4.1.2 --locked" >&2
      exit 1
    }
    generate_bindings
    cargo ndk --platform 29 -t arm64-v8a -t armeabi-v7a -t x86 -t x86_64 \
      -o "$native_root/generated/android/jniLibs" \
      build --locked -p "$core_package" --release --features ffi
    ;;
  ios)
    command -v xcodebuild >/dev/null || {
      echo "Xcode is required to build the iOS XCFramework" >&2
      exit 1
    }
    generate_bindings
    cargo +1.88.0 build --locked -p "$core_package" --release --features ffi \
      --target aarch64-apple-ios
    cargo +1.88.0 build --locked -p "$core_package" --release --features ffi \
      --target aarch64-apple-ios-sim
    cargo +1.88.0 build --locked -p "$core_package" --release --features ffi \
      --target x86_64-apple-ios

    local_sim="$CARGO_TARGET_DIR/opensesame-authenticator-ios-simulator.a"
    xcrun lipo -create \
      "$CARGO_TARGET_DIR/aarch64-apple-ios-sim/release/lib${library_name}.a" \
      "$CARGO_TARGET_DIR/x86_64-apple-ios/release/lib${library_name}.a" \
      -output "$local_sim"
    output="$native_root/ios/Libraries/OpenSesameAuthenticatorCoreFFI.xcframework"
    header_dir="$(mktemp -d)"
    trap 'rm -rf "$header_dir"' EXIT
    cp "$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_coreFFI.h" \
      "$header_dir/"
    cp "$native_root/ios/Sources/OpenSesameAuthenticatorCore/opensesame_authenticator_coreFFI.modulemap" \
      "$header_dir/module.modulemap"
    rm -rf "$output"
    mkdir -p "$(dirname "$output")"
    xcodebuild -create-xcframework \
      -library "$CARGO_TARGET_DIR/aarch64-apple-ios/release/lib${library_name}.a" \
      -headers "$header_dir" \
      -library "$local_sim" \
      -headers "$header_dir" \
      -output "$output"
    ;;
  *)
    echo "usage: $0 bindings|android|ios" >&2
    exit 2
    ;;
esac
