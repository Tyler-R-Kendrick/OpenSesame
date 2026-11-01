#!/usr/bin/env bash
# Three-tier agent coding chain: Grok Build → Kimi Code K3 → Cursor.
# Prints status only; never secrets. Exit 0 when at least one coding tier is up.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "$repo_root"

# Subscription auth from the Cursor store when present. A missing store is
# non-fatal here; grok-preflight reports it and the chain continues.
bash scripts/dev/grok-install-subscription-auth.sh || true

grok_ok=0
kimi_ok=0
grok_reason=""
kimi_reason=""

if bash scripts/dev/grok-preflight.sh >/tmp/grok-preflight.out 2>/tmp/grok-preflight.err; then
  grok_ok=1
  cat /tmp/grok-preflight.out
  if [[ -s /tmp/grok-preflight.err ]]; then
    cat /tmp/grok-preflight.err >&2
  fi
else
  cat /tmp/grok-preflight.out 2>/dev/null || true
  grok_reason="$(head -n 3 /tmp/grok-preflight.err 2>/dev/null | tr '\n' ' ')"
  printf 'grok preflight: failed (%s)\n' "${grok_reason:-unknown}"
fi

if [[ "$grok_ok" -eq 1 ]]; then
  model="$(scripts/dev/grok-resolve-model.sh)"
  printf 'grok resolved model: %s\n' "$model"
  printf 'recommended coding tier: 1 (Grok Build CLI)\n'
  printf 'invoke: scripts/dev/grok-headless.sh -p \"…\" -m %s --always-approve --output-format json (keys unset; subscription auth only)\n' \
    "$model"
  exit 0
fi

if bash scripts/dev/kimi-preflight.sh >/tmp/kimi-preflight.out 2>/tmp/kimi-preflight.err; then
  kimi_ok=1
  cat /tmp/kimi-preflight.out
else
  cat /tmp/kimi-preflight.out 2>/dev/null || true
  kimi_reason="$(head -n 3 /tmp/kimi-preflight.err 2>/dev/null | tr '\n' ' ')"
  printf 'kimi preflight: failed (%s)\n' "${kimi_reason:-unknown}"
fi

if [[ "$kimi_ok" -eq 1 ]]; then
  printf 'recommended coding tier: 2 (Kimi Code CLI, kimi-code/k3)\n'
  printf 'invoke: scripts/dev/kimi-headless.sh -p \"…\"\n'
  exit 0
fi

printf 'recommended coding tier: 3 (Cursor — Grok 4.7 for security testing; Composer/auto otherwise)\n'
printf 'record fallback reason in PR Provenance and docs/audit/2026-10-provenance.md\n'
exit 0
