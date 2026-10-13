#!/usr/bin/env bash
# Run Kimi Code K3 headless in a fix worktree. Exits 42 on quota/rate-limit for Composer fallback.
set -euo pipefail
WORKTREE="${1:?worktree path}"
PROMPT_FILE="${2:?prompt file}"
LOG="${3:-/tmp/deepsec-kimi-fix.log}"
MODEL="${DEEPSEC_KIMI_MODEL:-kimi-code/k3}"

export PATH="${HOME}/.local/bin:${PATH}"
unset MOONSHOT_API_KEY XAI_API_KEY GROK_DEPLOYMENT_KEY OPENAI_API_KEY ANTHROPIC_API_KEY

if [[ ! -f "${HOME}/.kimi-code/credentials/kimi-code.json" ]]; then
  echo "deepsec-kimi-fix-run: missing Kimi credentials" >&2
  exit 1
fi

cd "$WORKTREE"
echo "=== kimi fix run $(date -u +%Y-%m-%dT%H:%M:%SZ) cwd=$WORKTREE model=$MODEL ===" | tee "$LOG"
set +e
kimi -m "$MODEL" -p "$(cat "$PROMPT_FILE")" --output-format text 2>&1 | tee -a "$LOG"
EXIT=${PIPESTATUS[0]}
set -e
echo "=== kimi exit $EXIT $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

if grep -qiE '429|insufficient_quota|quota|rate limit|too many requests|usage limit' "$LOG"; then
  echo "deepsec-kimi-fix-run: Kimi quota/rate limit detected" >&2
  exit 42
fi
exit "$EXIT"
