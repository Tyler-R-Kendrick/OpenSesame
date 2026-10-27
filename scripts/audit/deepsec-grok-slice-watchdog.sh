#!/usr/bin/env bash
# Run a command with GNU timeout plus a hard wall-clock watchdog that SIGTERM/SIGKILLs
# the whole process group if the child survives past limit+grace+slack.
set -euo pipefail
LIMIT_SEC="${1:?limit sec}"
GRACE_SEC="${2:-30}"
SLACK_SEC="${3:-60}"
shift 3
START=$(date +%s)
HARD_LIMIT=$((LIMIT_SEC + GRACE_SEC + SLACK_SEC))
timeout -k "$GRACE_SEC" "$LIMIT_SEC" "$@" &
PID=$!
while kill -0 "$PID" 2>/dev/null; do
  ELAPSED=$(($(date +%s) - START))
  if ((ELAPSED >= HARD_LIMIT)); then
    echo "deepsec-grok-slice-watchdog: hard cap ${HARD_LIMIT}s — SIGTERM pgid ${PID}" >&2
    kill -TERM "-${PID}" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
    sleep 10
    kill -KILL "-${PID}" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    exit 124
  fi
  sleep 2
done
wait "$PID"
