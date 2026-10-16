#!/usr/bin/env bash
# Git checkouts can drop +x on audit scripts; wave-2 babysitters call this before probes/restarts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT="${ROOT}/scripts/audit"
for script in \
  deepsec-wave2-pick-agent.sh \
  deepsec-wave2-restart.sh \
  deepsec-wave2-grok-restart-strict-order.sh \
  deepsec-grok-quota-probe.sh \
  deepsec-kimi-quota-probe.sh \
  deepsec-grok-reinvestigate-wave.sh \
  deepsec-wave2-grok-process-ordered.sh \
  deepsec-wave2-grok-tier-run.sh \
  deepsec-wave2-process.sh \
  deepsec-wave2-kimi-parallel.sh \
  deepsec-kimi-monitor-tick.sh; do
  path="${AUDIT}/${script}"
  [[ -f "$path" ]] && chmod +x "$path"
done
