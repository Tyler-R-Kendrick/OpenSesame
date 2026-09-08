#!/usr/bin/env bash
# Semgrep gate — focused SAST on source trees only (never target/node_modules).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/lib/audit-directory.sh"
opensesame_audit_directory
if [[ -n "${SEMGREP_SETTINGS_FILE:-}" && -f "$SEMGREP_SETTINGS_FILE" ]]; then
  cp -- "$SEMGREP_SETTINGS_FILE" "$OPENSESAME_AUDIT_DIR/semgrep-settings.yml"
fi
export SEMGREP_SETTINGS_FILE="$OPENSESAME_AUDIT_DIR/semgrep-settings.yml"
export SEMGREP_LOG_FILE="$OPENSESAME_AUDIT_DIR/semgrep-user.log"

if ! command -v semgrep >/dev/null 2>&1; then
  echo "semgrep not installed" >&2
  exit 1
fi

REPORT="$OPENSESAME_AUDIT_DIR/semgrep.json"
# Keep rulesets small + scoped so the job completes without hanging agents.
RULES=(--config=p/rust --config=p/typescript --config=p/javascript)
PATHS=(apps crates packages)

echo "==> semgrep scan (ERROR+) on ${PATHS[*]}"
set +e
semgrep scan \
  "${RULES[@]}" \
  --severity=ERROR \
  --error \
  --metrics=off \
  --exclude='node_modules' \
  --exclude='target' \
  --exclude='.tools' \
  --exclude='dist' \
  --exclude='coverage' \
  --exclude='*.sqlite' \
  --json \
  --output="$REPORT" \
  "${PATHS[@]}" \
  2>"$OPENSESAME_AUDIT_DIR/semgrep.err"
status=$?
set -e

# Semgrep: 0 = clean, 1 = findings, 2 = fatal
if [[ "$status" -eq 2 ]]; then
  echo "semgrep gate: FAIL (scanner error)" >&2
  cat "$OPENSESAME_AUDIT_DIR/semgrep.err" >&2 || true
  exit 1
fi
if [[ "$status" -eq 1 ]]; then
  echo "semgrep gate: FAIL (ERROR-level findings)" >&2
  # Surface a short summary if jq available
  if command -v jq >/dev/null 2>&1 && [[ -f "$REPORT" ]]; then
    jq -r '.results[]? | "\(.extra.severity // "ERROR") \(.path):\(.start.line) \(.check_id)"' "$REPORT" | head -40 >&2 || true
  fi
  exit 1
fi

echo "semgrep gate: CLEAN"
exit 0
