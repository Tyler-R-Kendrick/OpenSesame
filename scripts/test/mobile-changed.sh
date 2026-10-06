#!/usr/bin/env bash
# Native checks must run when either the adapters or their Rust ABI changes.
set -euo pipefail
changed=true
if [[ "${BASE_SHA:-}" =~ ^[a-f0-9]{40}$ && "${HEAD_SHA:-}" =~ ^[a-f0-9]{40}$ ]]; then
  if paths="$(git diff --name-only "$BASE_SHA...$HEAD_SHA")"; then
    changed=false
    while IFS= read -r path; do
      case "$path" in
        *.md) ;;
        apps/android/*|crates/authenticator-core/*|Cargo.toml|Cargo.lock|rust-toolchain*|.github/workflows/ci.yml|scripts/test/mobile-*.sh)
          changed=true ;;
      esac
    done <<< "$paths"
  fi
fi
printf 'native_mobile=%s\n' "$changed"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'native_mobile=%s\n' "$changed" >> "$GITHUB_OUTPUT"
fi
