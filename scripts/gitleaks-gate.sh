#!/usr/bin/env bash
# gitleaks gate — secret scan that finishes on a dirty Rust/TS monorepo.
# Uses .gitleaks.toml path allowlists so `--no-git` does not walk target/node_modules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/security

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed" >&2
  exit 1
fi

CFG="$ROOT/.gitleaks.toml"
REPORT_DIR="artifacts/security/gitleaks-dir.json"
REPORT_GIT="artifacts/security/gitleaks-git.json"

# Working-tree scan is the primary gate (this is what hung without allowlists).
echo "==> gitleaks detect --no-git (working tree, allowlisted dirs pruned)"
set +e
gitleaks detect \
  --source "$ROOT" \
  --no-git \
  --config "$CFG" \
  --report-path "$REPORT_DIR" \
  --report-format json \
  --redact
dir_status=$?
set -e

if [[ "$dir_status" -gt 1 ]]; then
  echo "gitleaks gate: FAIL (scanner error status=$dir_status)" >&2
  exit 1
fi
if [[ "$dir_status" -eq 1 ]]; then
  echo "gitleaks gate: FAIL (working-tree leaks found)" >&2
  exit 1
fi

# Git history scan — report but do not fail the gate on pre-remediation commits.
# Set OPENSESAME_GITLEAKS_HISTORY_FAIL=1 to enforce history cleanliness.
echo "==> gitleaks detect (git history)"
set +e
gitleaks detect \
  --source "$ROOT" \
  --config "$CFG" \
  --report-path "$REPORT_GIT" \
  --report-format json \
  --redact
git_status=$?
set -e

if [[ "$git_status" -gt 1 ]]; then
  echo "gitleaks gate: FAIL (git scanner error status=$git_status)" >&2
  exit 1
fi
if [[ "$git_status" -eq 1 ]]; then
  if [[ "${OPENSESAME_GITLEAKS_HISTORY_FAIL:-}" == "1" ]]; then
    echo "gitleaks gate: FAIL (git history leaks; OPENSESAME_GITLEAKS_HISTORY_FAIL=1)" >&2
    exit 1
  fi
  echo "gitleaks gate: WARN (git history findings present; working tree clean)"
fi

echo "gitleaks gate: CLEAN"
exit 0
