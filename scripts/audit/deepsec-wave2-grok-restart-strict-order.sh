#!/usr/bin/env bash
# Restart Grok ordered wave-2 after recording strict-gate baseline for reorder metrics.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BASELINE="${ROOT}/.deepsec/wave2-grok-strict-reorder-baseline.json"
progress="$(node "${ROOT}/scripts/audit/deepsec-wave2-progress.mjs" "$ROOT" 2 2>/dev/null || true)"
node -e "
const fs = require('fs');
const progress = JSON.parse(process.argv[1]);
const payload = {
  reorderedAt: new Date().toISOString(),
  marker: progress.marker ?? 2,
  filesCompleteAtReorder: progress.filesComplete ?? 0,
  filesTracked: progress.filesTracked ?? 1986,
};
fs.mkdirSync(require('path').dirname(process.argv[2]), { recursive: true });
fs.writeFileSync(process.argv[2], JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify(payload));
" "$progress" "$BASELINE"
"${ROOT}/scripts/audit/deepsec-wave2-restart.sh"
