#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="${HOME}/.local/bin:${PATH}"
LOG=/tmp/deepsec-ci-orchestrator.log
exec >>"$LOG" 2>&1

wait_kimi() {
  while pgrep -f "$1" >/dev/null; do sleep 20; done
}

run_kimi() {
  echo "=== orchestrator kimi $(date -u +%H:%M:%S) $1 ==="
  "$ROOT/scripts/audit/deepsec-kimi-fix-run.sh" "$1" "$2" "$3" || true
}

wait_kimi 'kimi-ci-850'
wait_kimi 'kimi-ci-08f341'

ensure_wt() {
  local wt="$1" br="$2"
  if [[ ! -d "$wt" ]]; then
    git -C "$ROOT" fetch origin "$br"
    git -C "$ROOT" worktree add "$wt" "origin/$br"
  fi
}

for br_wt in \
  "cursor/deepsec-fix-9004ac142fcc4d31:${ROOT}/.worktrees/kimi-ci-850" \
  "cursor/deepsec-fix-a1e774d3565c9af5:${ROOT}/.worktrees/kimi-ci-904"; do
  br="${br_wt%%:*}"
  wt="${br_wt#*:}"
  ensure_wt "$wt" "$br"
  (
    cd "$wt" && git fetch origin "$br" && git checkout "$br" && git pull --ff-only origin "$br"
    if git cat-file -e 3ea22385^{commit} 2>/dev/null && ! git merge-base --is-ancestor 3ea22385 HEAD; then
      git cherry-pick 3ea22385 && git push origin "$br"
    fi
  ) || true
done

for spec in 904:cursor/deepsec-fix-a1e774d3565c9af5:#904 905:cursor/deepsec-fix-db53526e593772dd:#905 906:cursor/deepsec-fix-afe9924a15cb3b16:#906; do
  pr="${spec%%:*}"
  rest="${spec#*:}"
  br="${rest%%:*}"
  prnum="${rest#*:}"
  wt="${ROOT}/.worktrees/kimi-ci-${pr}"
  ensure_wt "$wt" "$br"
  cat >"/tmp/kimi-ci-${pr}.prompt" <<EOF
Repair CI on branch $br (draft PR $prnum). Parent stack includes vite manualChunks fix (3ea22385 on af73 branch). Cherry-pick if missing. Verify bundle budgets (minimal-local-hardened, family-local-hardened). Never raise budgets. No unsigned merge commits.

KIMI_CI_REPAIR_DONE branch=$br pr=$prnum
EOF
  run_kimi "$wt" "/tmp/kimi-ci-${pr}.prompt" "/tmp/kimi-ci-${pr}.log"
done

run_kimi "${ROOT}/.worktrees/kimi-ci-773" "/tmp/kimi-ci-773.prompt" "/tmp/kimi-ci-773.log"
echo "=== orchestrator done $(date -u +%H:%M:%S) ==="
