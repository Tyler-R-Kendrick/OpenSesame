#!/usr/bin/env bash
# Pinned tools for the weekly checks. Application code still targets Rust 1.88.
set -euo pipefail
check="${1:?required check name}"
case "$check" in
  mutation-typescript|mutation-duress|mutation-rust|dependencies|sast|secrets|kani|miri|shuttle|fuzz-rust|fuzz-typescript) ;;
  *) echo "Unknown release check: $check" >&2; exit 1 ;;
esac
tools_root="${RUNNER_TEMP:?}/release-tools/$check"
report_root="$RUNNER_TEMP/release-checks/$check"
mkdir -p "$tools_root/bin"
mkdir -m 700 -p "$report_root"
export PATH="$tools_root/bin:$PATH"
printf '%s\n' "$tools_root/bin" >> "${GITHUB_PATH:?}"
exec > >(tee "$report_root/tools.log") 2>&1

fetch_verified() {
  local url="$1" digest="$2" destination="$3"
  curl --fail --location --retry 3 "$url" -o "$destination"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status
}

case "$check" in
  mutation-rust)
    cargo +1.88.0 install cargo-mutants --version 25.3.1 --locked --root "$tools_root"
    cargo +1.88.0 mutants --version
    ;;
  dependencies)
    cargo +1.88.0 install cargo-audit --version 0.21.2 --locked --root "$tools_root"
    cargo +1.88.0 install cargo-deny --version 0.18.4 --locked --root "$tools_root"
    fetch_verified \
      https://github.com/google/osv-scanner/releases/download/v2.5.0/osv-scanner_linux_amd64 \
      edcfc41d257db36148f065055655fe3fcfc434b0b423ea67468a84c207524e0c \
      "$tools_root/bin/osv-scanner"
    chmod 700 "$tools_root/bin/osv-scanner"
    printf 'OPENSESAME_OSV_SCANNER_BIN=%s\n' "$tools_root/bin/osv-scanner" >> "$GITHUB_ENV"
    printf '%s\n' 'OPENSESAME_OSV_SCANNER_VERSION=2.5.0' \
      'OPENSESAME_OSV_SCANNER_SHA256=edcfc41d257db36148f065055655fe3fcfc434b0b423ea67468a84c207524e0c' >> "$GITHUB_ENV"
    cargo +1.88.0 audit --version
    cargo +1.88.0 deny --version
    osv-scanner --version
    ;;
  sast)
    cargo +1.88.0 install ast-grep --version 0.40.5 --locked --root "$tools_root"
    python3 -m venv "$tools_root/semgrep"
    "$tools_root/semgrep/bin/pip" install 'semgrep==1.143.0'
    printf '%s\n' "$tools_root/semgrep/bin" >> "$GITHUB_PATH"
    ast-grep --version
    "$tools_root/semgrep/bin/semgrep" --version
    ;;
  secrets)
    fetch_verified \
      https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz \
      551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb \
      "$tools_root/gitleaks.tar.gz"
    tar -xzf "$tools_root/gitleaks.tar.gz" -C "$tools_root/bin" gitleaks
    gitleaks version
    ;;
  kani)
    cargo +1.88.0 install kani-verifier --version 0.65.0 --locked --root "$tools_root"
    cargo kani setup
    cargo kani --version
    ;;
  miri)
    cargo +nightly-2026-08-01 miri setup
    cargo +nightly-2026-08-01 miri --version
    ;;
  fuzz-rust)
    cargo +1.94.0 install cargo-fuzz --version 0.13.2 --locked --root "$tools_root"
    cargo +nightly-2026-08-01 fuzz --version
    ;;
  fuzz-typescript)
    pnpm --filter @opensesame/fuzz rebuild
    (cd tests/fuzz/jazzer && node -e 'import("@jazzer.js/core")')
    ;;
esac
node --version
pnpm --version
rustc +1.88.0 --version
date -u +%Y-%m-%dT%H:%M:%SZ
