#!/usr/bin/env bash
# Grok auth preflight for Cursor Cloud Agents. Prints statuses only — never
# the API key, never ~/.grok/auth.json, never a successful models body.
#
# Exit 0 when OIDC auth.json exists or the models call returns 200.
# Exit 1 when the key returns 403 (credits) or there is no auth at all.
# A depleted runtime key still shadows device login, so that case names
# scripts/dev/grok-headless.sh on stderr.
set -euo pipefail

auth_file="${HOME}/.grok/auth.json"
key_len=0
if [[ -n "${XAI_API_KEY:-}" ]]; then
  key_len=${#XAI_API_KEY}
fi
printf 'XAI_API_KEY length: %s\n' "$key_len"

oidc=0
if [[ -e "$auth_file" ]]; then
  oidc=1
  printf '%s\n' "~/.grok/auth.json: present"
else
  printf '%s\n' "~/.grok/auth.json: absent"
fi

http_code=""
body_file=""
cleanup() {
  if [[ -n "$body_file" ]]; then
    rm -f "$body_file"
  fi
}
trap cleanup EXIT

# One redacted line. The key is read from the environment inside Python so
# it is never interpolated into the shell trace of this script.
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

if [[ "$key_len" -gt 0 ]]; then
  body_file="$(mktemp)"
  curl_rc=0
  set +e
  http_code="$(
    curl -sS -o "$body_file" -w '%{http_code}' \
      --max-time 30 \
      -H "Authorization: Bearer ${XAI_API_KEY}" \
      -H "Accept: application/json" \
      https://api.x.ai/v1/models
  )"
  curl_rc=$?
  set -e
  if [[ "$curl_rc" -ne 0 || -z "$http_code" ]]; then
    http_code="000"
  fi
  # Status only. The body stays off stdout unless the call failed.
  printf 'models HTTP: %s\n' "$http_code"
  if [[ "$http_code" != "200" && -s "$body_file" ]]; then
    first_line="$(head -n 1 "$body_file" || true)"
    redacted=""
    if [[ -n "$first_line" ]]; then
      redacted="$(printf '%s' "$first_line" | redact_error_line)"
    fi
    if [[ -n "$redacted" ]]; then
      printf 'models error: %s\n' "$redacted"
    fi
  fi
fi

if [[ "$http_code" == "403" ]]; then
  printf '%s\n' "device OAuth requires running grok via scripts/dev/grok-headless.sh when XAI_API_KEY is set but depleted" >&2
fi

# OIDC on disk or a working key is enough to proceed. 403 is still reported
# above, because the runtime secret shadows device login until it is unset.
if [[ "$http_code" == "200" || "$oidc" -eq 1 ]]; then
  exit 0
fi

if [[ "$http_code" == "403" ]]; then
  printf '%s\n' "Grok preflight failed: API key returned 403 credits." >&2
  exit 1
fi

printf '%s\n' "Grok preflight failed: no auth at all." >&2
exit 1
