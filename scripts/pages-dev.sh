#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

export OPENSESAME_ENV="${OPENSESAME_ENV:-development}"
export OPENSESAME_LISTEN="${OPENSESAME_LISTEN:-127.0.0.1:18787}"
export OPENSESAME_PUBLIC_URL="${OPENSESAME_PUBLIC_URL:-http://127.0.0.1:18787}"
export VITE_HOST_API="${VITE_HOST_API:-$OPENSESAME_PUBLIC_URL}"
export OPENSESAME_CORS_ORIGINS="${OPENSESAME_CORS_ORIGINS:-http://127.0.0.1:5180,http://localhost:5180}"
export OPENSESAME_DEV_BOOTSTRAP="${OPENSESAME_DEV_BOOTSTRAP:-true}"
export OPENSESAME_CONNECTION_KEY="${OPENSESAME_CONNECTION_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
IDENTITY_URL="${OPENSESAME_IDENTITY_URL:-http://127.0.0.1:8788}"

cargo +1.88.0 run --offline -p opensesame-gateway -- --listen "$OPENSESAME_LISTEN" &
HOST_PID=$!
OPENSESAME_PUBLIC_URL="$IDENTITY_URL" \
OPENSESAME_ISSUER="$IDENTITY_URL" \
OPENSESAME_HOST_API="$VITE_HOST_API" \
pnpm --filter @opensesame/control-plane start &
IDENTITY_PID=$!
trap 'kill "$HOST_PID" "$IDENTITY_PID" 2>/dev/null || true' EXIT INT TERM

wait_for() {
  local url="$1"
  for _ in {1..600}; do
    curl --fail --silent "$url" >/dev/null && return
    sleep 0.1
  done
  curl --fail --silent --show-error "$url" >/dev/null
}

wait_for "$VITE_HOST_API/health/live"
wait_for "$IDENTITY_URL/v1/health/live"

pnpm --filter @opensesame/pages dev:web "$@"
