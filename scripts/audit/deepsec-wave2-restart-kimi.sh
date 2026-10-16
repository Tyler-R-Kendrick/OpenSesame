#!/usr/bin/env bash
# Legacy name: restart wave-2 (Grok-first per deepsec-wave2-restart.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
exec "${ROOT}/scripts/audit/deepsec-wave2-restart.sh"
