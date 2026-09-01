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
export OPENSESAME_CORS_ORIGINS="${OPENSESAME_CORS_ORIGINS:-http://127.0.0.1:5180,http://localhost:5180,https://tyler-r-kendrick.github.io}"
export OPENSESAME_DEV_BOOTSTRAP="${OPENSESAME_DEV_BOOTSTRAP:-true}"
export OPENSESAME_CONNECTION_KEY="${OPENSESAME_CONNECTION_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
mkdir -p .tools/run
export OPENSESAME_DB="${OPENSESAME_DB:-sqlite://$REPO_ROOT/.tools/run/opensesame.db?mode=rwc}"
# Optional: seal GitHub history without an OAuth App (Settings PAT form also works).
# export GITHUB_TOKEN=ghp_…
# OAuth App path (Authorize button): OPENSESAME_PROVIDER_GITHUB_CLIENT_ID / _CLIENT_SECRET
#
# Social sign-in (dev): four branded providers, each backed by its own local
# mock IdP instance, so every button completes a real leg against the seeded
# account. shoo.dev is the production broker and stays out of the dev catalog —
# the Google button here is the first-party `google` registry entry.
# Production gets these from OPENSESAME_PROVIDERS + real OAuth client
# credentials instead, e.g.
#   export OPENSESAME_PROVIDERS=google,github
#   export OPENSESAME_PROVIDER_GOOGLE_CLIENT_ID=…  (+ _CLIENT_SECRET)
export OPENSESAME_TRUSTED_UPSTREAMS="${OPENSESAME_TRUSTED_UPSTREAMS:-http://127.0.0.1:9090,http://localhost:9090}"
export OPENSESAME_PROVIDERS="${OPENSESAME_PROVIDERS:-google,github,apple,microsoft}"
export OPENSESAME_PROVIDER_GOOGLE_ISSUER="${OPENSESAME_PROVIDER_GOOGLE_ISSUER:-http://127.0.0.1:9091}"
export OPENSESAME_PROVIDER_GITHUB_ISSUER="${OPENSESAME_PROVIDER_GITHUB_ISSUER:-http://127.0.0.1:9092}"
export OPENSESAME_PROVIDER_GITHUB_AUTHORIZE_URL="${OPENSESAME_PROVIDER_GITHUB_AUTHORIZE_URL:-http://127.0.0.1:9092/login/oauth/authorize}"
export OPENSESAME_PROVIDER_GITHUB_TOKEN_URL="${OPENSESAME_PROVIDER_GITHUB_TOKEN_URL:-http://127.0.0.1:9092/login/oauth/access_token}"
export OPENSESAME_PROVIDER_GITHUB_USERINFO_URL="${OPENSESAME_PROVIDER_GITHUB_USERINFO_URL:-http://127.0.0.1:9092/api/user}"
export OPENSESAME_PROVIDER_GITHUB_EMAILS_URL="${OPENSESAME_PROVIDER_GITHUB_EMAILS_URL:-http://127.0.0.1:9092/api/user/emails}"
export OPENSESAME_PROVIDER_GITHUB_CLIENT_ID="${OPENSESAME_PROVIDER_GITHUB_CLIENT_ID:-mock-oauth2-app}"
export OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET="${OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET:-mock-oauth2-dev-secret}"
export OPENSESAME_PROVIDER_APPLE_ISSUER="${OPENSESAME_PROVIDER_APPLE_ISSUER:-http://127.0.0.1:9093}"
export OPENSESAME_PROVIDER_MICROSOFT_ISSUER="${OPENSESAME_PROVIDER_MICROSOFT_ISSUER:-http://127.0.0.1:9094}"
export OPENSESAME_CONTROL_PLANE_PORT="${OPENSESAME_CONTROL_PLANE_PORT:-18788}"
# Brokered sign-in runs as origin-profile public clients (ADR 0050) — without
# this the hosted page refuses every social button with invalid_client.
export OPENSESAME_ORIGIN_CLIENTS_ENABLED="${OPENSESAME_ORIGIN_CLIENTS_ENABLED:-true}"
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
# One mock instance per demo social provider (issuers above). The GitHub leg is
# OAuth2-shaped, so its instance shares the client the registry is configured
# with; the OIDC ones need nothing but their port.
SOCIAL_IDP_PIDS=()
OPENSESAME_MOCK_IDP_PORT=9091 pnpm --filter @opensesame/mock-upstream-idp dev &
SOCIAL_IDP_PIDS+=($!)
OPENSESAME_MOCK_IDP_PORT=9092 \
OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_ID="$OPENSESAME_PROVIDER_GITHUB_CLIENT_ID" \
OPENSESAME_MOCK_IDP_OAUTH2_CLIENT_SECRET="$OPENSESAME_PROVIDER_GITHUB_CLIENT_SECRET" \
  pnpm --filter @opensesame/mock-upstream-idp dev &
SOCIAL_IDP_PIDS+=($!)
OPENSESAME_MOCK_IDP_PORT=9093 pnpm --filter @opensesame/mock-upstream-idp dev &
SOCIAL_IDP_PIDS+=($!)
OPENSESAME_MOCK_IDP_PORT=9094 pnpm --filter @opensesame/mock-upstream-idp dev &
SOCIAL_IDP_PIDS+=($!)
trap 'kill "$HOST_PID" "$IDENTITY_PID" "$MOCK_IDP_PID" "${SOCIAL_IDP_PIDS[@]}" 2>/dev/null || true' EXIT INT TERM

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
for port in 9091 9092 9093 9094; do
  wait_for "http://127.0.0.1:${port}/health"
done

# WebAuthn rejects IP origins (`127.0.0.1`) with "This is an invalid domain."
# Prefer http://localhost:5180 for passkey enroll/unlock (CORS allows both).
echo "Pages UI: http://localhost:5180  (use localhost, not 127.0.0.1, for passkeys)" >&2
echo "Mock IdP (guest claim): $MOCK_IDP_URL" >&2

pnpm --filter @opensesame/pages dev:web "$@"
