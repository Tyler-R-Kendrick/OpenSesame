#!/usr/bin/env bash
# gitleaks gate — secret scan that finishes on a dirty Rust/TS monorepo.
# Uses .gitleaks.toml path allowlists so `--no-git` does not walk target/node_modules.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks not installed" >&2
  exit 1
fi

CFG="$ROOT/.gitleaks.toml"
REPORT_DIR="$OPENSESAME_AUDIT_DIR/gitleaks-dir.json"
REPORT_GIT="$OPENSESAME_AUDIT_DIR/gitleaks-git.json"

# The scanner sees every non-build source path. Reviewed working-tree fixtures
# are evaluated afterward using their exact file and match digests. Keep raw
# reports and scanner output private; never emit a matched credential.
WORK_DIR="$(mktemp -d "$OPENSESAME_AUDIT_DIR/.gitleaks-private.XXXXXXXX")"
chmod 700 "$WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT
REVIEW_MANIFEST="$ROOT/scripts/security/gitleaks-reviewed-working-tree.json"
REVIEW_GATE="$ROOT/scripts/security/gitleaks-working-tree-gate.mjs"
node "$REVIEW_GATE" prepare "$ROOT" "$REVIEW_MANIFEST" "$WORK_DIR/state.json"
echo "==> gitleaks detect --no-git (working tree)"
set +e
gitleaks detect \
  --source . \
  --no-git \
  --config "$CFG" \
  --report-path "$WORK_DIR/raw.json" \
  --report-format json \
  --no-banner \
  --log-level error >"$WORK_DIR/scanner-output" 2>&1
dir_status=$?
set -e
if [[ "$dir_status" -gt 1 ]]; then
  echo "gitleaks gate: FAIL (scanner error status=$dir_status)" >&2
  exit 1
fi
if ! node "$REVIEW_GATE" classify "$ROOT" "$REVIEW_MANIFEST" "$WORK_DIR/state.json" \
  "$WORK_DIR/raw.json" "$REPORT_DIR" "$dir_status"; then
  echo "gitleaks gate: FAIL (unreviewed finding or invalid evidence)" >&2
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
  --redact=100
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
  echo "gitleaks gate: WARN (git history findings present; no unreviewed working-tree findings)"
  echo "gitleaks gate: PASS (history findings remain)"
else
  echo "gitleaks gate: CLEAN (no unreviewed working-tree findings; git history clean)"
fi
exit 0
