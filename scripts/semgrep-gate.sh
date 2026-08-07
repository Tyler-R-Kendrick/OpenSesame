#!/usr/bin/env bash
# Semgrep gate — focused SAST on source trees only (never target/node_modules).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p artifacts/security

if ! command -v semgrep >/dev/null 2>&1; then
  echo "semgrep not installed" >&2
  exit 1
fi

REPORT="artifacts/security/semgrep.json"
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
  2>artifacts/security/semgrep.err
status=$?
set -e

# Semgrep: 0 = clean, 1 = findings, 2 = fatal
if [[ "$status" -eq 2 ]]; then
  echo "semgrep gate: FAIL (scanner error)" >&2
  cat artifacts/security/semgrep.err >&2 || true
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
