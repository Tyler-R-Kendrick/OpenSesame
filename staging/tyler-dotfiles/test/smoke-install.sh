#!/usr/bin/env bash
# Syntax and pin checks for install.sh. Does not download tools.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install="${root}/install.sh"

bash -n "${install}"
bash -n "${root}/harness/shell/env.sh"
bash -n "${root}/harness/shell/stitch-env.sh"
bash -n "${root}/harness/scripts/agent-coding-preflight.sh"
bash -n "${root}/harness/scripts/grok-headless.sh"
bash -n "${root}/harness/scripts/grok-install-subscription-auth.sh"
bash -n "${root}/harness/scripts/grok-preflight.sh"
bash -n "${root}/harness/scripts/grok-resolve-model.sh"
bash -n "${root}/harness/scripts/kimi-headless.sh"
bash -n "${root}/harness/scripts/kimi-preflight.sh"

# Comments may name the forbidden pattern. Executable lines must not use it.
uncommented="$(grep -vE '^[[:space:]]*#' "${install}" || true)"
if printf '%s\n' "${uncommented}" | grep -Eq 'curl[^|]*\|[[:space:]]*(bash|sh)\b|wget[^|]*\|[[:space:]]*(bash|sh)\b'; then
  printf 'install.sh pipes a downloader into a shell\n' >&2
  exit 1
fi
if printf '%s\n' "${uncommented}" | grep -Eq '(^|[^[:alnum:]_])sudo([^[:alnum:]_]|$)'; then
  printf 'install.sh elevates privileges\n' >&2
  exit 1
fi

grep -q 'MISE_VERSION="2026.10.18"' "${install}"
grep -q '0d41b60745a6273a80089c86f80d8729042d2f57f87fda70aecc7d1c3ffbd3be' "${install}"
grep -q 'c5a49a47f8184f5649f3d8685b408bd72325a823f41cf618c60f3ffc303090a1' "${install}"
grep -q 'vendor/install-cloud-cli.mjs' "${install}"
grep -q 'vendor/downloads.json' "${install}"

for tool in fd github-cli jq ripgrep shellcheck; do
  grep -q "^${tool} = \"latest\"" "${root}/mise.toml"
  grep -q "${tool}" "${install}"
done

if command -v node >/dev/null 2>&1; then
  node --check "${root}/vendor/install-cloud-cli.mjs"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
    "${root}/vendor/downloads.json"
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' \
    "${root}/harness/claude/settings.local.json"
fi

printf 'smoke-install: ok\n'
