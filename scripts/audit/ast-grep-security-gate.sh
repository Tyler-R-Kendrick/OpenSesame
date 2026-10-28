#!/usr/bin/env bash
# ast-grep security gate — fails on any error-level rule match.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
RULES="$ROOT/tools/security/ast-grep-rules.yml"

if ! command -v ast-grep >/dev/null 2>&1; then
  echo "ast-grep not installed" >&2
  exit 1
fi

echo "==> ast-grep security scan"
set +e
ast-grep scan --inline-rules "$(cat "$RULES")" \
  --globs '!**/__snapshots__/**' \
  apps crates packages \
  2>"$OPENSESAME_AUDIT_DIR/ast-grep.err" \
  | tee "$OPENSESAME_AUDIT_DIR/ast-grep.out"
statuses=("${PIPESTATUS[@]}")
set -e

# Findings, parser/configuration errors, and a failed report write all fail.
# Text formatting or the availability of rg must never change the verdict.
if [[ "${statuses[0]}" -ne 0 || "${statuses[1]}" -ne 0 ]]; then
  echo "ast-grep gate: FAIL (scanner ${statuses[0]}, report ${statuses[1]})" >&2
  cat "$OPENSESAME_AUDIT_DIR/ast-grep.err" >&2 || true
  exit 1
fi

echo "ast-grep gate: CLEAN"
exit 0
