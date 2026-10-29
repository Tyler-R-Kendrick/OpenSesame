#!/usr/bin/env bash
# Semgrep gate — focused SAST on source trees only (never target/node_modules).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
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

# Only exit zero can be a clean scan. Semgrep has error codes beyond 2.
if [[ "$status" -ne 0 && "$status" -ne 1 ]]; then
  echo "semgrep gate: FAIL (scanner error $status)" >&2
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

python3 - "$REPORT" <<'PY'
import json, sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text())
if not isinstance(report, dict) or not isinstance(report.get("results"), list) or not isinstance(report.get("errors"), list):
    sys.exit("semgrep gate: FAIL (incomplete JSON report)")
if report["errors"] or report["results"]:
    sys.exit("semgrep gate: FAIL (errors or findings in report)")
paths = report.get("paths")
if not isinstance(paths, dict) or not isinstance(paths.get("scanned"), list) or not paths["scanned"]:
    sys.exit("semgrep gate: FAIL (no scanned files)")
PY

echo "semgrep gate: CLEAN"
exit 0
