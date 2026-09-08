#!/usr/bin/env bash
# ast-grep security gate — fails on any error-level rule match.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
RULES="$ROOT/security/ast-grep-rules.yml"

if ! command -v ast-grep >/dev/null 2>&1; then
  echo "ast-grep not installed" >&2
  exit 1
fi

echo "==> ast-grep security scan"
set +e
ast-grep scan --inline-rules "$(cat "$RULES")" \
  --globs '!**/*.test.*' --globs '!**/*.spec.*' --globs '!**/__snapshots__/**' \
  apps crates packages \
  2>"$OPENSESAME_AUDIT_DIR/ast-grep.err" \
  | tee "$OPENSESAME_AUDIT_DIR/ast-grep.out"
status=${PIPESTATUS[0]}
set -e

# ast-grep exits non-zero when error findings exist; also treat any "error[" line as fail
if rg -q '^error\[' "$OPENSESAME_AUDIT_DIR/ast-grep.out" "$OPENSESAME_AUDIT_DIR/ast-grep.err" 2>/dev/null; then
  echo "ast-grep gate: FAIL (error-level findings)" >&2
  rg '^error\[' "$OPENSESAME_AUDIT_DIR/ast-grep.out" "$OPENSESAME_AUDIT_DIR/ast-grep.err" || true
  exit 1
fi

# Exit 2 from ast-grep can mean parse issues — surface them
if [[ "$status" -gt 1 ]]; then
  echo "ast-grep gate: FAIL (scanner status $status)" >&2
  cat "$OPENSESAME_AUDIT_DIR/ast-grep.err" >&2 || true
  exit 1
fi

echo "ast-grep gate: CLEAN"
exit 0
