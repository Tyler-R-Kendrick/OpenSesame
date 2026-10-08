#!/usr/bin/env bash
# Kimi Code auth preflight for Cursor Cloud Agents. Status lines only — never
# tokens, never credential file bodies.
#
# Exit 0 when OAuth credentials exist under ~/.kimi-code/credentials/ or
# KIMI_MODEL_API_KEY is set. Exit 1 when neither is available.
set -euo pipefail

KIMI_MODEL_PIN="${KIMI_MODEL_PIN:-k3}"

if ! command -v kimi >/dev/null 2>&1; then
  printf '%s\n' "kimi: not on PATH" >&2
  exit 1
fi

version="$(kimi --version 2>/dev/null || true)"
printf 'kimi version: %s\n' "${version:-unknown}"

ignored_key_len=0
if [[ -n "${KIMI_API_KEY:-}" ]]; then
  ignored_key_len=${#KIMI_API_KEY}
fi
printf 'KIMI_API_KEY length: %s (ignored by Kimi)\n' "$ignored_key_len"

model_key_len=0
if [[ -n "${KIMI_MODEL_API_KEY:-}" ]]; then
  model_key_len=${#KIMI_MODEL_API_KEY}
fi
printf 'KIMI_MODEL_API_KEY length: %s\n' "$model_key_len"

configured_model="${KIMI_MODEL_NAME:-$KIMI_MODEL_PIN}"
printf 'model pin: %s (headless default -m %s; catalog alias kimi-k3)\n' \
  "$configured_model" "$KIMI_MODEL_PIN"

case "$configured_model" in
  k3 | kimi-k3)
    printf 'model K3: ok\n'
    ;;
  *)
    if [[ -n "${KIMI_MODEL_NAME:-}" ]]; then
      printf '%s\n' \
        "KIMI_MODEL_NAME must be k3 or kimi-k3 for K3; got \"${KIMI_MODEL_NAME}\"." >&2
      exit 1
    fi
    ;;
esac

oauth_present="$(
  python3 <<'PY'
import glob
import json
import os

cred_dir = os.path.join(os.path.expanduser("~"), ".kimi-code", "credentials")
if not os.path.isdir(cred_dir):
    print(0)
    raise SystemExit(0)
for path in glob.glob(os.path.join(cred_dir, "*.json")):
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError:
        continue
    except json.JSONDecodeError:
        continue
    token = data.get("access_token")
    if isinstance(token, str) and token.strip():
        print(1)
        raise SystemExit(0)
print(0)
PY
)"

if [[ "$oauth_present" == "1" ]]; then
  printf '%s\n' "~/.kimi-code/credentials/oauth: present"
else
  printf '%s\n' "~/.kimi-code/credentials/oauth: absent"
fi

if [[ "$oauth_present" == "1" || "$model_key_len" -gt 0 ]]; then
  exit 0
fi

printf '%s\n' \
  "Kimi preflight failed: run kimi login on the VM or set Runtime Secret KIMI_MODEL_API_KEY." >&2
exit 1
