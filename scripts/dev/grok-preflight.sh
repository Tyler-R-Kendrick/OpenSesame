#!/usr/bin/env bash
# Grok subscription preflight for Cursor Cloud Agents. Prints statuses only —
# never API keys, never ~/.grok/auth.json contents, never a models body.
#
# Tier-1 health is `grok models` with API keys unset. Exit 0 only when that
# succeeds. A set XAI_API_KEY, or API 403/credits, is misconfiguration — not
# quota exhaustion. Subscription quota/limit text from grok itself is real
# tier-1 exhaustion. This script does not call api.x.ai with the key.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

bash "${script_dir}/grok-install-subscription-auth.sh" || true

auth_file="${HOME}/.grok/auth.json"
key_len=0
if [[ -n "${XAI_API_KEY:-}" ]]; then
  key_len=${#XAI_API_KEY}
fi
printf 'XAI_API_KEY length: %s\n' "$key_len"
if [[ "$key_len" -gt 0 ]]; then
  printf '%s\n' "warning: runtime API key must be unset (misconfiguration). Unset XAI_API_KEY and use subscription auth." >&2
fi

if [[ -e "$auth_file" ]]; then
  printf '%s\n' "~/.grok/auth.json: present"
else
  printf '%s\n' "~/.grok/auth.json: absent"
  printf '%s\n' "Grok preflight failed: subscription auth missing (~/.grok/auth.json absent)." >&2
  exit 1
fi

# One redacted line. Secrets are read from the environment inside Python so
# they are never interpolated into the shell trace of this script.
redact_error_line() {
  python3 -c '
import os, re, sys
line = sys.stdin.readline()
if not line:
    sys.exit(0)
line = line.rstrip("\r\n")
for name in ("XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_DEPLOYMENT_KEY"):
    secret = os.environ.get(name) or ""
    if secret:
        line = line.replace(secret, "[redacted]")
line = re.sub(r"(?i)bearer\s+\S+", "Bearer [redacted]", line)
line = re.sub(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "[redacted]", line)
line = re.sub(r"\b(?:sk|xai|grok)-[A-Za-z0-9_-]{6,}", "[redacted]", line)
sys.stdout.write(line[:500])
'
}

err_file="$(mktemp)"
cleanup() {
  rm -f "$err_file"
}
trap cleanup EXIT

models_rc=0
set +e
env -u XAI_API_KEY -u GROK_CODE_XAI_API_KEY -u GROK_DEPLOYMENT_KEY \
  grok models >/dev/null 2>"$err_file"
models_rc=$?
set -e

if [[ "$models_rc" -ne 0 ]]; then
  printf 'grok models exit: %s\n' "$models_rc"
  first_line="$(head -n 1 "$err_file" 2>/dev/null || true)"
  redacted=""
  if [[ -n "$first_line" ]]; then
    redacted="$(printf '%s\n' "$first_line" | redact_error_line || true)"
  fi
  if [[ -n "$redacted" ]]; then
    printf 'grok models error: %s\n' "$redacted"
  fi

  if printf '%s' "$redacted" | grep -Eiq 'weekly|quota|usage exceeded|rate limit|too many requests|\b429\b'; then
    printf '%s\n' "Grok preflight failed: subscription quota or weekly limit (tier-1 exhaustion)." >&2
  elif printf '%s' "$redacted" | grep -Eiq '403' && printf '%s' "$redacted" | grep -Eiq 'credit'; then
    printf '%s\n' "Grok preflight failed: API key 403/credits is misconfiguration. Unset XAI_API_KEY and use subscription auth." >&2
  else
    printf '%s\n' "Grok preflight failed: grok models failed with API keys unset." >&2
  fi
  exit 1
fi

resolved="$(
  cd "$repo_root" && bash scripts/dev/grok-resolve-model.sh 2>/dev/null || printf '%s' 'grok-4.7'
)"
printf '%s\n' "grok subscription: ok"
printf 'grok resolved model: %s\n' "$resolved"
exit 0
