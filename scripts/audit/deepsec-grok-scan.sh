#!/usr/bin/env bash
# Run a deepsec scan + headless AI investigation (Cursor CLI preferred, else Grok Build).
# No XAI_API_KEY / AI Gateway pay-per-use. Usage: deepsec-grok-scan.sh [phase]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WS="${ROOT}/.deepsec"
PROJECT_ID=opensesame
MODEL="${DEEPSEC_GROK_MODEL:-grok-4.7}"
AGENT="${DEEPSEC_AGENT:-}"
PHASE="${1:-all}"

cd "$ROOT"

if [[ ! -d "$WS/node_modules/deepsec" ]]; then
  echo "==> installing .deepsec workspace"
  (cd "$WS" && pnpm install)
fi

DEEPSEC="${WS}/node_modules/.bin/deepsec"

pick_agent() {
  if [[ -n "$AGENT" ]]; then
    echo "$AGENT"
    return 0
  fi
  if command -v cursor-agent >/dev/null 2>&1; then
    echo "cursor"
    return 0
  fi
  if command -v grok >/dev/null 2>&1; then
    echo "grok"
    return 0
  fi
  echo "deepsec-grok-scan: neither cursor-agent nor grok on PATH" >&2
  return 1
}

cursor_auth_check() {
  if ! command -v cursor-agent >/dev/null 2>&1; then
    return 1
  fi
  local probe
  probe="$(cursor-agent -p "reply OK" --model "$MODEL" --print --force 2>&1 || true)"
  if echo "$probe" | grep -qiE 'not (authenticated|logged in)|login required'; then
    echo "deepsec-grok-scan: cursor-agent is not signed in." >&2
    echo "  Install Cursor CLI and run cursor-agent login on this machine." >&2
    return 1
  fi
  if [[ -z "${probe// }" ]]; then
    echo "deepsec-grok-scan: cursor-agent returned empty probe (check install/auth)." >&2
    return 1
  fi
  return 0
}

grok_auth_check() {
  if ! command -v grok >/dev/null 2>&1; then
    echo "deepsec-grok-scan: grok CLI not on PATH" >&2
    return 1
  fi
  local probe
  probe="$(unset XAI_API_KEY GROK_DEPLOYMENT_KEY; grok -p "reply OK" -m "$MODEL" --always-approve --output-format json 2>&1 || true)"
  if echo "$probe" | grep -q "Not signed in"; then
    echo "deepsec-grok-scan: Grok Build is not signed in (subscription)." >&2
    echo "  unset XAI_API_KEY && grok login --device-auth" >&2
    echo "  Open the printed URL and confirm the device code." >&2
    return 1
  fi
  return 0
}

ai_auth_check() {
  AGENT="$(pick_agent)" || return 1
  case "$AGENT" in
    cursor) cursor_auth_check ;;
    grok) grok_auth_check ;;
    *)
      echo "deepsec-grok-scan: unknown DEEPSEC_AGENT=$AGENT (use cursor or grok)" >&2
      return 1
      ;;
  esac
}

# Area prefixes (relative to repo root) for --filter
export DEEPSEC_AREA_CORE="crates/core/,crates/client-core/,crates/host-core/,packages/app-core/,packages/vault-core/"
export DEEPSEC_AREA_PWA="apps/pages/"
export DEEPSEC_AREA_CLI="apps/cli/,packages/cli/"

run_scan() {
  echo "==> deepsec scan (pattern matchers)"
  (cd "$WS" && "$DEEPSEC" scan --project-id "$PROJECT_ID")
}

run_process_area() {
  local name="$1"
  local filter="$2"
  local limit="${3:-}"
  echo "==> deepsec process --agent $AGENT --model $MODEL --filter $filter ${limit:+--limit $limit}"
  local limit_args=()
  if [[ -n "$limit" ]]; then
    limit_args=(--limit "$limit")
  fi
  (
    cd "$WS"
    unset XAI_API_KEY GROK_DEPLOYMENT_KEY
    "$DEEPSEC" process --project-id "$PROJECT_ID" \
      --agent "$AGENT" \
      --model "$MODEL" \
      --thinking-level "${DEEPSEC_THINKING:-high}" \
      --concurrency "${DEEPSEC_CONCURRENCY:-1}" \
      --filter "$filter" \
      "${limit_args[@]}"
  )
}

run_revalidate() {
  echo "==> deepsec revalidate --agent $AGENT --model $MODEL"
  (
    cd "$WS"
    unset XAI_API_KEY GROK_DEPLOYMENT_KEY
    "$DEEPSEC" revalidate --project-id "$PROJECT_ID" \
      --agent "$AGENT" \
      --model "$MODEL" \
      --thinking-level "${DEEPSEC_THINKING:-high}" \
      --concurrency "${DEEPSEC_CONCURRENCY:-1}"
  )
}

run_triage() {
  echo "==> triage --agent grok --model $MODEL (Grok Build plugin; subscription)"
  (
    cd "$ROOT"
    unset XAI_API_KEY GROK_DEPLOYMENT_KEY
    export DEEPSEC_CONCURRENCY="${DEEPSEC_CONCURRENCY:-2}"
    node scripts/audit/deepsec-grok-triage.mjs --all-severities
  )
}

run_export() {
  local out="${WS}/findings-grok"
  echo "==> deepsec export -> $out"
  (cd "$WS" && "$DEEPSEC" export --project-id "$PROJECT_ID" --format md-dir --out "$out")
}

case "$PHASE" in
  scan)
    run_scan
    ;;
  process)
    ai_auth_check
    run_process_area core "crates/core/" "${DEEPSEC_LIMIT:-}"
    run_process_area core-client "crates/client-core/" "${DEEPSEC_LIMIT:-}"
    run_process_area core-host "crates/host-core/" "${DEEPSEC_LIMIT:-}"
    run_process_area app-core "packages/app-core/" "${DEEPSEC_LIMIT:-}"
    run_process_area vault-core "packages/vault-core/" "${DEEPSEC_LIMIT:-}"
    run_process_area pwa "apps/pages/" "${DEEPSEC_LIMIT:-}"
    run_process_area cli-native "apps/cli/" "${DEEPSEC_LIMIT:-}"
    run_process_area cli-ts "packages/cli/" "${DEEPSEC_LIMIT:-}"
    ;;
  revalidate)
    ai_auth_check
    run_revalidate
    ;;
  triage)
    run_triage
    ;;
  export)
    run_export
    ;;
  all)
    run_scan
    if ai_auth_check; then
      export DEEPSEC_LIMIT="${DEEPSEC_LIMIT:-0}"
      if [[ "$DEEPSEC_LIMIT" == "0" ]]; then
        echo "==> DEEPSEC_LIMIT unset or 0: skipping AI process (set DEEPSEC_LIMIT to investigate pending files)"
      else
        "$0" process
        "$0" revalidate
        run_triage
        run_export
      fi
    else
      echo "==> Skipping AI process/revalidate until cursor-agent or Grok Build login completes."
      exit 2
    fi
    ;;
  *)
    echo "Usage: $0 [scan|process|revalidate|triage|export|all]" >&2
    exit 1
    ;;
esac

echo "deepsec-grok-scan: OK ($PHASE)"
