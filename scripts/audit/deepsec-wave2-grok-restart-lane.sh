#!/usr/bin/env bash
# Restart Grok ordered reinvestigate only (leave Kimi parallel running).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY
bash "${ROOT}/scripts/audit/deepsec-wave2-ensure-executable.sh" 2>/dev/null || true

if pgrep -f 'grok -p' >/dev/null; then
  echo "deepsec-wave2-grok-restart-lane: grok investigate active — waiting up to 120s for slice boundary"
  for _ in $(seq 1 24); do
    sleep 5
    if ! pgrep -f 'grok -p' >/dev/null; then
      break
    fi
  done
fi

pkill -9 -f 'grok -p ' 2>/dev/null || true
pkill -9 -f 'deepsec/dist/cli.mjs process.*--agent grok' 2>/dev/null || true
pkill -9 -f 'deepsec-wave2-grok-process-ordered.sh' 2>/dev/null || true
pkill -9 -f 'deepsec-wave2-grok-tier-run.sh' 2>/dev/null || true
pkill -9 -f 'deepsec-grok-reinvestigate-wave.sh' 2>/dev/null || true
sleep 1

if ! read -r AGENT _ < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh"); then
  echo "deepsec-wave2-grok-restart-lane: no agent available" >&2
  exit 1
fi
if [[ "$AGENT" != "grok" ]]; then
  echo "deepsec-wave2-grok-restart-lane: expected grok, got $AGENT" >&2
  exit 1
fi
echo "deepsec-wave2-grok-restart-lane: starting reinvestigate (grok only)"
nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
