#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

export OPENSESAME_ENV="${OPENSESAME_ENV:-development}"
export OPENSESAME_ALLOW_DEV_DEFAULTS="${OPENSESAME_ALLOW_DEV_DEFAULTS:-true}"
# Prefer :18787/:18788 so a foreign process on the classic :8787/:8788 ports
# cannot silently steal Authority / Connections auth (common on shared hosts).
export OPENSESAME_LISTEN="${OPENSESAME_LISTEN:-127.0.0.1:18787}"
export OPENSESAME_PUBLIC_URL="${OPENSESAME_PUBLIC_URL:-http://127.0.0.1:18787}"
export VITE_HOST_API="${VITE_HOST_API:-$OPENSESAME_PUBLIC_URL}"
export OPENSESAME_CORS_ORIGINS="${OPENSESAME_CORS_ORIGINS:-http://127.0.0.1:5180,http://localhost:5180}"
export OPENSESAME_DEV_BOOTSTRAP="${OPENSESAME_DEV_BOOTSTRAP:-true}"
export OPENSESAME_CONNECTION_KEY="${OPENSESAME_CONNECTION_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
# Optional: seal GitHub history without an OAuth App (Settings PAT form also works).
# export GITHUB_TOKEN=ghp_…
# OAuth App path (Authorize button): OPENSESAME_PROVIDER_GITHUB_CLIENT_ID / _CLIENT_SECRET
export OPENSESAME_CONTROL_PLANE_PORT="${OPENSESAME_CONTROL_PLANE_PORT:-18788}"
IDENTITY_URL="${OPENSESAME_IDENTITY_URL:-http://127.0.0.1:${OPENSESAME_CONTROL_PLANE_PORT}}"
export VITE_IDENTITY_API="${VITE_IDENTITY_API:-$IDENTITY_URL}"

cargo +1.88.0 run --offline -p opensesame-gateway -- --listen "$OPENSESAME_LISTEN" &
HOST_PID=$!
OPENSESAME_PUBLIC_URL="$IDENTITY_URL" \
OPENSESAME_ISSUER="$IDENTITY_URL" \
OPENSESAME_HOST_API="$VITE_HOST_API" \
OPENSESAME_CONTROL_PLANE_PORT="$OPENSESAME_CONTROL_PLANE_PORT" \
OPENSESAME_CORS_ORIGINS="$OPENSESAME_CORS_ORIGINS" \
pnpm --filter @opensesame/control-plane start &
IDENTITY_PID=$!
export OPENSESAME_MOCK_IDP_PORT="${OPENSESAME_MOCK_IDP_PORT:-9090}"
MOCK_IDP_URL="http://127.0.0.1:${OPENSESAME_MOCK_IDP_PORT}"
pnpm --filter @opensesame/mock-upstream-idp dev &
MOCK_IDP_PID=$!
trap 'kill "$HOST_PID" "$IDENTITY_PID" "$MOCK_IDP_PID" 2>/dev/null || true' EXIT INT TERM

wait_for() {
  local url="$1"
  for _ in {1..600}; do
    curl --fail --silent "$url" >/dev/null && return
    sleep 0.1
  done
  curl --fail --silent --show-error "$url" >/dev/null
}

# Identity health must be OpenSesame `{ "status": "ok" }`. A foreign listener on
# the same port often answers 401 with an unrelated JSON error and looks "up".
wait_for_identity() {
  local url="$1"
  local body=""
  for _ in {1..600}; do
    body="$(curl --silent --show-error "$url" || true)"
    if [[ "$body" == *'"status":"ok"'* ]] || [[ "$body" == *'"status": "ok"'* ]]; then
      return
    fi
    sleep 0.1
  done
  echo "Identity at $url is not OpenSesame control-plane (got: ${body:-empty})." >&2
  echo "Free that port or set OPENSESAME_IDENTITY_URL / OPENSESAME_CONTROL_PLANE_PORT." >&2
  exit 1
}

wait_for "$VITE_HOST_API/health/live"
wait_for_identity "$IDENTITY_URL/v1/health/live"
wait_for "$MOCK_IDP_URL/.well-known/openid-configuration"

# WebAuthn rejects IP origins (`127.0.0.1`) with "This is an invalid domain."
# Prefer http://localhost:5180 for passkey enroll/unlock (CORS allows both).
echo "Pages UI: http://localhost:5180  (use localhost, not 127.0.0.1, for passkeys)" >&2
echo "Mock IdP (guest claim): $MOCK_IDP_URL" >&2

pnpm --filter @opensesame/pages dev:web "$@"
