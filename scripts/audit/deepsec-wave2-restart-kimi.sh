#!/usr/bin/env bash
# Kill stuck Kimi wave-2 process and start a fresh reinvestigate run (subscription only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

pkill -f 'deepsec/dist/cli.mjs process.*--agent kimi' 2>/dev/null || true
pkill -f 'deepsec-grok-reinvestigate-wave.sh' 2>/dev/null || true
sleep 2

if ! "${ROOT}/scripts/audit/deepsec-kimi-quota-probe.sh"; then
  echo "deepsec-wave2-restart-kimi: quota limited — not starting" >&2
  exit 1
fi

nohup "${ROOT}/scripts/audit/deepsec-grok-reinvestigate-wave.sh" >>/tmp/deepsec-reinvestigate-wave.nohup 2>&1 &
echo "deepsec-wave2-restart-kimi: started reinvestigate (pid $!)"
