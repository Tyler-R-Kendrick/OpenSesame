#!/usr/bin/env bash
# Pinned public tools only; a failed real install fails the family.
set -euo pipefail
family="${1:?test-depth family required}"
: "${RUNNER_TEMP:?hosted runner temp required}"
: "${TEST_DEPTH_EVIDENCE:?private evidence directory required}"
tool_root="$RUNNER_TEMP/test-depth-tools"
mkdir -p "$tool_root/bin"
export PATH="$tool_root/bin:$PATH"
printf '%s\n' "$tool_root/bin" >> "$GITHUB_PATH"

install_cargo_tool() {
  cargo +1.88.0 install --locked --version "$2" --root "$tool_root" "$1"
}

install_scanners() {
  python3 -m venv "$tool_root/semgrep"
  "$tool_root/semgrep/bin/pip" install 'semgrep==1.179.0'
  printf '%s\n' "$tool_root/semgrep/bin" >> "$GITHUB_PATH"
  export PATH="$tool_root/semgrep/bin:$PATH"
  export SEMGREP_SETTINGS_FILE="$TEST_DEPTH_EVIDENCE/semgrep-settings.yml"
  npm install --prefix "$tool_root/npm" 'cve-lite-cli@1.38.0' '@ast-grep/cli@0.45.3'
  printf '%s\n' "$tool_root/npm/node_modules/.bin" >> "$GITHUB_PATH"
  export PATH="$tool_root/npm/node_modules/.bin:$PATH"
  local release="https://github.com/gitleaks/gitleaks/releases/download/v8.30.1"
  local archive="gitleaks_8.30.1_linux_x64.tar.gz"
  curl -fsSL "$release/$archive" -o "$tool_root/$archive"
  curl -fsSL "$release/gitleaks_8.30.1_checksums.txt" -o "$tool_root/checksums.txt"
  (cd "$tool_root"; awk -v file="$archive" '$2 == file { print }' checksums.txt > selected.sha256; test -s selected.sha256; sha256sum -c selected.sha256)
  tar -xzf "$tool_root/$archive" -C "$tool_root/bin" gitleaks
  install_cargo_tool cargo-audit 0.22.2
  semgrep --version | grep -Fx '1.179.0'
  ast-grep --version | grep -Fx 'ast-grep 0.45.3'
  gitleaks version | grep -Fx '8.30.1'
  node -e 'const p=require(process.argv[1]); if(p.version!=="1.38.0") process.exit(1)' "$tool_root/npm/node_modules/cve-lite-cli/package.json"
  cargo +1.88.0 audit --version | grep -F '0.22.2'
  "$tool_root/semgrep/bin/pip" freeze > "$TEST_DEPTH_EVIDENCE/scanner-python-packages.txt"
  cp "$tool_root/npm/package-lock.json" "$TEST_DEPTH_EVIDENCE/scanner-package-lock.json"
}

case "$family" in
  coverage-rust)
    rustup component add llvm-tools-preview --toolchain 1.88.0
    install_cargo_tool cargo-llvm-cov 0.9.1
    cargo +1.88.0 llvm-cov --version | grep -F '0.9.1'
    ;;
  mutation-rust)
    install_cargo_tool cargo-mutants 27.1.0
    cargo +1.88.0 mutants --version | grep -F '27.1.0'
    ;;
  fuzz-rust)
    rustup toolchain install nightly-2026-10-06 --profile minimal
    cargo +nightly-2026-10-06 install --locked --version 0.13.2 --root "$tool_root" cargo-fuzz
    cargo +nightly-2026-10-06 fuzz --version | grep -F '0.13.2'
    rustc +nightly-2026-10-06 --version | grep -F '1.101.0-nightly (ea137335b 2026-10-05)'
    ;;
  scans) install_scanners ;;
  verify) pnpm --filter @opensesame/visual-contract exec playwright install --with-deps chromium ;;
  fuzz-ts|feature-fuzz)
    (cd tests/fuzz/jazzer; node --input-type=module -e 'await import("@jazzer.js/core")')
    ;;
  coverage-ts|mutation-ts|feature-mutation|feature-extension) ;;
  *) echo "Unknown tool family: $family" >&2; exit 2 ;;
esac
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22||minor<22) process.exit(1); console.log(process.version)'
pnpm --version | grep -Fx '9.15.0'
rustc +1.88.0 --version | grep -F 'rustc 1.88.0 '
df -B1 "$PWD" "$RUNNER_TEMP"
