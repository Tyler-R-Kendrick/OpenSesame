#!/usr/bin/env bash
# Thin launcher: one Grok Build job → one stacked draft PR (launcher only; no source edits here).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FINDING_ID="${1:?usage: deepsec-grok-fix-launch.sh <finding_id> <n> <total> <pr_base_branch>}"
N="${2:?n}"
TOTAL="${3:?total}"
PR_BASE_BRANCH="${4:?pr_base_branch — main for stack 1/ N, else previous cursor/deepsec-fix-* branch}"
BASE_PR="${DEEPSEC_FIX_BASE_PR:-773}"
SLUG="${FINDING_ID#finding_}"
BRANCH="cursor/deepsec-fix-${SLUG}"
LOG_DIR="${ROOT}/.cache/deepsec-grok-fix"
PROMPT="${LOG_DIR}/${FINDING_ID}.prompt.md"
DEBUG_LOG="${LOG_DIR}/${FINDING_ID}.debug.json"
JOB_LOG="${LOG_DIR}/${FINDING_ID}.job.log"
PID_FILE="${LOG_DIR}/${FINDING_ID}.pid"
mkdir -p "$LOG_DIR"

QUEUE_JSON="$(node "${ROOT}/scripts/audit/deepsec-grok-fix-queue.mjs" "$ROOT")"
ROW="$(node -e "
const q=JSON.parse(process.argv[1]);
const r=q.queue.find(x=>x.id===process.argv[2]);
if(!r){console.error('finding not in queue');process.exit(1);}
console.log(JSON.stringify(r));
" "$QUEUE_JSON" "$FINDING_ID")"

TITLE="$(node -e "console.log(JSON.parse(process.argv[1]).title)" "$ROW")"
SEV="$(node -e "console.log(JSON.parse(process.argv[1]).severity)" "$ROW")"
FILE="$(node -e "console.log(JSON.parse(process.argv[1]).filePath)" "$ROW")"
LINES="$(node -e "console.log(JSON.parse(process.argv[1]).lines)" "$ROW")"
VERDICT="$(node -e "console.log(JSON.parse(process.argv[1]).verdict)" "$ROW")"
SLUG_LINE="$(node -e "console.log(JSON.parse(process.argv[1]).slug||'')" "$ROW")"

cat >"$PROMPT" <<EOF
You are fixing **exactly one** deepsec security finding on OpenSesame. You MUST do all work yourself:
code, tests, CI fixes, rebase, **small incremental commits**, push, and \`gh pr create\` (draft). No bundling multiple findings.

## Finding (this PR only)
- **ID:** ${FINDING_ID}
- **Severity:** ${SEV}
- **Verdict:** ${VERDICT}
- **Location:** \`${FILE}:${LINES}\`
- **Slug:** ${SLUG_LINE}
- **Title:** ${TITLE}

## Stacked PR contract (mandatory)
- **Stack position:** ${N}/${TOTAL} based on #${BASE_PR}
- **This draft PR base branch:** \`${PR_BASE_BRANCH}\`
  - Stack 1/${TOTAL}: base is \`main\`.
  - Stack k>1: base is the **previous** fix branch in the stack (the branch merged into by the prior PR), NOT \`main\`.
- **Head branch (create from base):** \`${BRANCH}\` (prefix \`cursor/deepsec-fix-\`)
- **One finding per PR.** Do not fix other deepsec findings in this branch. A tightly related second issue in the **same file** may share this PR only if it is the same root cause — never a repo-wide sweep.
- **Never** open one PR that addresses many findings or many files unrelated to this id.

## Commits (mandatory)
- **Small incremental commits** — each commit does one thing (e.g. product fix; then regression test; then quality baseline ratchet if required).
- Do **not** squash everything into a single commit before push.
- Use descriptive commit messages. Follow repo signing rules for this environment.

## PR body (mandatory)
Include:
- Finding id, severity, file:line
- Line: \`${N}/${TOTAL} based on #${BASE_PR}\`
- Stack: base branch \`${PR_BASE_BRANCH}\` → head \`${BRANCH}\`
- Credit: fix authored by Kimi Code K3 (subscription OAuth, kimi-code/k3)

## CI / process
- Fetch latest \`origin/main\` and rebase your stack base as needed.
- Required checks green: TypeScript, Bundle budgets, Rust.
- Do **not** merge. Do **not** touch \`cursor/cf-audit-*\` or persona branches (#784–#789).
- No \`XAI_API_KEY\`, no gateway. No sudo.

## Fix quality
- Regression test at the enforcement boundary.
- AGENTS.md, DESIGN.md, anti-slop.

If blocked after reasonable effort, exit non-zero and explain.

When done, print exactly one line:
DEEPSEC_FIX_DONE pr=<url> branch=${BRANCH} base=${PR_BASE_BRANCH}
EOF

echo "$$" >"$PID_FILE"
echo "=== launch ${FINDING_ID} stack ${N}/${TOTAL} base=${PR_BASE_BRANCH} $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$JOB_LOG"
echo "prompt: $PROMPT" | tee -a "$JOB_LOG"
echo "debug: $DEBUG_LOG" | tee -a "$JOB_LOG"

cd "$ROOT"
START="$(date +%s)"
set +e
export PATH="${HOME}/.local/bin:${PATH}"
env -u XAI_API_KEY -u GROK_DEPLOYMENT_KEY -u MOONSHOT_API_KEY \
  kimi -m "${DEEPSEC_KIMI_MODEL:-kimi-code/k3}" -p "$(cat "$PROMPT")" \
  --output-format text >>"$JOB_LOG" 2>&1
EXIT=$?
if grep -qiE '429|insufficient_quota|quota|rate limit|too many requests|usage limit' "$JOB_LOG"; then
  EXIT=42
fi
set -e
END="$(date +%s)"
rm -f "$PID_FILE"
echo "=== exit ${EXIT} duration $((END - START))s $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$JOB_LOG"
exit "$EXIT"
