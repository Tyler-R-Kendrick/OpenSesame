#!/usr/bin/env bash
# Wait for Kimi 5-hour quota reset, then resume deepsec with DEEPSEC_CONCURRENCY=2.
# Short sleeps; status + log review every ~25 minutes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEEPSEC="${ROOT}/.deepsec/node_modules/.bin/deepsec"
LOG="${DEEPSEC_RESUME_LOG:-/tmp/deepsec-kimi-resume.log}"
WATCH_LOG="/tmp/deepsec-kimi-quota-watch.log"
PROBE_INTERVAL_SEC="${PROBE_INTERVAL_SEC:-300}"
STATUS_EVERY_N="${STATUS_EVERY_N:-5}"
n=0

exec >>"$WATCH_LOG" 2>&1
echo "=== quota-watch start $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

quota_clear_probe() {
  local out ec
  out="$(mktemp /tmp/deepsec-quota-probe.XXXXXX.log)"
  set +e
  timeout 90 kimi -p 'reply ok' >"$out" 2>&1
  ec=$?
  set -e
  echo "=== kimi quota probe $(date -u +%Y-%m-%dT%H:%M:%SZ) exit=$ec ===" >>/tmp/deepsec-quota-probe.log
  cat "$out" >>/tmp/deepsec-quota-probe.log
  if grep -qiE '5-hour usage limit|provider\.auth_error:\s*403|kimi quota or rate limit' "$out"; then
    rm -f "$out"
    return 1
  fi
  if [[ "$ec" -ne 0 ]]; then
    rm -f "$out"
    return 1
  fi
  rm -f "$out"
  return 0
}

while true; do
  n=$((n + 1))
  should_probe=0
  if (( n % STATUS_EVERY_N == 0 )); then
    should_probe=1
    echo "=== status check $(date -u +%Y-%m-%dT%H:%M:%SZ) (tick $n) ==="
    (cd "${ROOT}/.deepsec" && "$DEEPSEC" status --project-id opensesame) || true
    echo "--- resume log tail ---"
    tail -n 8 "$LOG" 2>/dev/null || true
  fi

  if [[ "$should_probe" -eq 1 ]]; then
    if quota_clear_probe; then
      echo "=== quota appears clear $(date -u +%Y-%m-%dT%H:%M:%SZ) — starting resume concurrency=2 ==="
      export DEEPSEC_CONCURRENCY=2
      export DEEPSEC_THINKING=medium
      unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY
      if "${ROOT}/scripts/audit/deepsec-kimi-resume.sh"; then
        echo "=== resume script finished OK $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
        exit 0
      fi
      ec=$?
      if [[ "$ec" -eq 2 ]]; then
        echo "=== resume hit quota again (exit 2); back to watch $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      else
        echo "=== resume exited $ec $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
      fi
    else
      echo "=== quota still limited (probe) $(date -u +%Y-%m-%dT%H:%M:%SZ) (tick $n) ==="
    fi
  else
    echo "=== sleep tick $n $(date -u +%Y-%m-%dT%H:%M:%SZ) — next status/probe in $(( STATUS_EVERY_N - (n % STATUS_EVERY_N) )) ticks ==="
  fi

  sleep "$PROBE_INTERVAL_SEC"
done
