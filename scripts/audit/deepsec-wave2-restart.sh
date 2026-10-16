#!/usr/bin/env bash
# Restart wave-2 reinvestigate (Grok / Kimi / Composer per deepsec-wave2-pick-agent.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

pkill -9 -f 'grok -p ' 2>/dev/null || true
pkill -9 -f 'deepsec/dist/cli.mjs process.*--reinvestigate' 2>/dev/null || true
pkill -9 -f 'deepsec/dist/cli.mjs process.*--agent kimi' 2>/dev/null || true
pkill -9 -f 'deepsec/dist/cli.mjs process.*--agent grok' 2>/dev/null || true
pkill -9 -f 'deepsec-grok-reinvestigate-wave.sh' 2>/dev/null || true
sleep 1
# No broad final sweep: an unscoped `kill -9` over every deepsec process
# would also kill unrelated waves/agents sharing this host.

if ! read -r AGENT _ < <("${ROOT}/scripts/audit/deepsec-wave2-pick-agent.sh"); then
  echo "deepsec-wave2-restart: no agent available — not starting" >&2
  exit 1
fi
echo "deepsec-wave2-restart: starting reinvestigate agent=$AGENT"
nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
