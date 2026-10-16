#!/usr/bin/env bash
# Run Grok wave-2 reinvestigate in priority tiers (1 → 2 → 3). Subscription only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WAVE="${DEEPSEC_REINVESTIGATE_WAVE:-2}"
PERSIST_STATE="${ROOT}/.deepsec/wave2-grok-tier-state.json"
STATE="${DEEPSEC_GROK_TIER_STATE:-$PERSIST_STATE}"
if [[ ! -f "$STATE" && -f /tmp/deepsec-wave2-grok-tier-state.json ]]; then
  cp /tmp/deepsec-wave2-grok-tier-state.json "$STATE"
fi
mkdir -p "$(dirname "$PERSIST_STATE")"
SUMMARY_LOG="${DEEPSEC_GROK_TIER_SUMMARY_LOG:-/tmp/deepsec-wave2-grok-tier-summaries.log}"
export PATH="${HOME}/.local/bin:${PATH}"
unset XAI_API_KEY GROK_DEPLOYMENT_KEY MOONSHOT_API_KEY

node "${ROOT}/scripts/audit/deepsec-wave2-grok-tier-stats.mjs" "$ROOT" "$WAVE" | tee /tmp/deepsec-wave2-grok-tier-stats.json

for TIER in 1 2 3; do
  COUNT="$(node "${ROOT}/scripts/audit/deepsec-wave2-grok-manifest.mjs" "$ROOT" "$WAVE" "$TIER" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).length))")"
  if [[ "$COUNT" == "0" ]]; then
    echo "deepsec-wave2-grok-tier-run: tier $TIER empty — skip"
    continue
  fi
  STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "=== grok wave-$WAVE tier $TIER start $STARTED ($COUNT files) ==="
  node -e "
const fs=require('fs');
let state={};
try { state=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); } catch {}
state.currentTier=${TIER};
state['tier${TIER}StartedAt']='${STARTED}';
state['tier${TIER}PendingAtStart']=${COUNT};
const out=JSON.stringify(state,null,2)+'\n';
fs.writeFileSync(process.argv[1], out);
try { fs.writeFileSync(process.argv[2], out); } catch {}
" "$STATE" "$PERSIST_STATE"
  export DEEPSEC_GROK_TIER="$TIER"
  if [[ "$TIER" == "1" ]]; then
    export DEEPSEC_CONCURRENCY="${DEEPSEC_GROK_TIER1_CONCURRENCY:-2}"
  fi
  if ! DEEPSEC_REINVESTIGATE_WAVE="$WAVE" "${ROOT}/scripts/audit/deepsec-wave2-process.sh"; then
    echo "=== grok tier $TIER paused (no agent) $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 0
  fi
  DONE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "=== grok wave-$WAVE tier $TIER done $DONE ==="
  SUMMARY="$(node "${ROOT}/scripts/audit/deepsec-wave2-grok-tier-summary.mjs" "$TIER" "$STARTED" "$ROOT" "$WAVE")"
  echo "$SUMMARY" | tee -a "$SUMMARY_LOG"
  {
    echo "----- tier $TIER summary $DONE -----"
    echo "$SUMMARY"
  } >>"${DEEPSEC_REINVESTIGATE_LOG:-/tmp/deepsec-reinvestigate-wave.log}"
done

echo "=== grok tiered wave-$WAVE complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
