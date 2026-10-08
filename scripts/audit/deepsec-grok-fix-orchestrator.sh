#!/usr/bin/env bash
# Launch the next stacked Grok fix job (one at a time). Launcher only — no app source edits.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${ROOT}/.cache/deepsec-grok-fix/stack-state.json"
LOG_DIR="${ROOT}/.cache/deepsec-grok-fix"
mkdir -p "$LOG_DIR"
BASE_PR="${DEEPSEC_FIX_BASE_PR:-773}"

scan_ready() {
  grep -q "=== REVALIDATE" /tmp/deepsec-grok-finish.log 2>/dev/null && \
    grep -q "FINISH COMPLETE" /tmp/deepsec-grok-finish.log 2>/dev/null
}

if ! scan_ready; then
  if ! grep -q "FINISH COMPLETE" /tmp/deepsec-grok-finish.log 2>/dev/null; then
    echo "scan not complete: wait for deepsec-grok-finish (see /tmp/deepsec-grok-watch.log)"
    exit 0
  fi
fi

QUEUE_JSON="$(node "${ROOT}/scripts/audit/deepsec-grok-fix-queue.mjs" "$ROOT")"
TOTAL="$(node -e "console.log(JSON.parse(process.argv[1]).total)" "$QUEUE_JSON")"

if [[ ! -f "$STATE" ]]; then
  node -e "
const fs=require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
  basePr: Number(process.argv[2]),
  nextIndex: 0,
  items: [],
  lastExit: null,
  lastDurationSec: null
}, null, 2));
" "$STATE" "$BASE_PR"
fi

# Any job still running?
if compgen -G "${LOG_DIR}/*.pid" > /dev/null; then
  for pf in "${LOG_DIR}"/*.pid; do
    pid="$(cat "$pf" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "grok fix job in flight pid=$pid ($(basename "$pf" .pid))"
      exit 0
    fi
  done
fi

STATE_JSON="$(cat "$STATE")"
NEXT="$(node -e "console.log(JSON.parse(process.argv[1]).nextIndex)" "$STATE_JSON")"
if [[ "$NEXT" -ge "$TOTAL" ]]; then
  echo "stack complete: ${TOTAL} findings queued"
  exit 0
fi

LAST_EXIT="$(node -e "const s=JSON.parse(process.argv[1]); console.log(s.lastExit===null?'':s.lastExit)" "$STATE_JSON")"
if [[ -n "$LAST_EXIT" && "$LAST_EXIT" != "0" ]]; then
  echo "stopped: previous job exit ${LAST_EXIT}; fix logs under ${LOG_DIR}"
  exit 1
fi

FINDING_ID="$(node -e "
const q=JSON.parse(process.argv[1]);
const i=Number(process.argv[2]);
console.log(q.queue[i].id);
" "$QUEUE_JSON" "$NEXT")"

N=$((NEXT + 1))
PR_BASE="main"
if [[ "$NEXT" -gt 0 ]]; then
  PR_BASE="$(node -e "
const s=JSON.parse(process.argv[1]);
const prev=s.items[s.items.length-1];
if(!prev||!prev.branch){process.exit(1);}
console.log(prev.branch);
" "$STATE_JSON")"
fi

JOB_LOG="${LOG_DIR}/${FINDING_ID}.job.log"
echo "nohup stack ${N}/${TOTAL} ${FINDING_ID} base=${PR_BASE} -> ${JOB_LOG}"
nohup bash "${ROOT}/scripts/audit/deepsec-grok-fix-launch.sh" \
  "$FINDING_ID" "$N" "$TOTAL" "$PR_BASE" >>"${LOG_DIR}/orchestrator.log" 2>&1 &
ORCH_PID=$!
echo "orchestrator spawned wrapper pid=${ORCH_PID}"

# Wait for launch script to finish in background and update state (separate watcher)
nohup bash -c "
set -euo pipefail
ROOT='$ROOT'
STATE='$STATE'
FINDING_ID='$FINDING_ID'
N='$N'
TOTAL='$TOTAL'
PR_BASE='$PR_BASE'
JOB_LOG='$JOB_LOG'
bash \"\$ROOT/scripts/audit/deepsec-grok-fix-launch.sh\" \"\$FINDING_ID\" \"\$N\" \"\$TOTAL\" \"\$PR_BASE\"
EXIT=\$?
DURATION=\$(grep -E '^=== exit' \"\$JOB_LOG\" | tail -1 | sed -n 's/.*duration \\([0-9]*\\)s.*/\\1/p')
PR_URL=\$(grep -oE 'DEEPSEC_FIX_DONE pr=[^ ]+' \"\$JOB_LOG\" | tail -1 | sed 's/DEEPSEC_FIX_DONE pr=//')
BRANCH=\$(grep -oE 'branch=[^ ]+' \"\$JOB_LOG\" | tail -1 | sed 's/branch=//')
node -e \"
const fs=require('fs');
const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
s.lastExit=Number(process.argv[2]);
s.lastDurationSec=process.argv[3]?Number(process.argv[3]):null;
s.items.push({
  index: s.nextIndex,
  findingId: process.argv[4],
  n: Number(process.argv[5]),
  total: Number(process.argv[6]),
  prBase: process.argv[7],
  branch: process.argv[8]||'',
  prUrl: process.argv[9]||'',
  exit: Number(process.argv[2]),
  durationSec: s.lastDurationSec
});
s.nextIndex+=1;
fs.writeFileSync(process.argv[1], JSON.stringify(s,null,2));
\" \"\$STATE\" \"\$EXIT\" \"\${DURATION:-}\" \"\$FINDING_ID\" \"\$N\" \"\$TOTAL\" \"\$PR_BASE\" \"\${BRANCH:-}\" \"\${PR_URL:-}\"
" >>"${LOG_DIR}/orchestrator.log" 2>&1 &
