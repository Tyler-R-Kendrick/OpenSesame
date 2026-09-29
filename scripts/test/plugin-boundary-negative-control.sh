#!/usr/bin/env bash
# Negative control for scripts/audit/plugin-boundary-gate.sh (ADR 0150 §7).
#
# A gate that cannot fail proves nothing. Pointed at the plugin crate itself —
# a tree that certainly contains opensesame-surrogate-proxy and rcgen — the
# gate must FAIL and name both; pointed at the real targets it must pass.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

gate=scripts/audit/plugin-boundary-gate.sh

if out="$(PLUGIN_BOUNDARY_TARGETS=opensesame-surrogate-proxy bash "$gate" 2>&1)"; then
  echo "plugin-boundary negative control: FAIL — the gate passed a tree that links the plugin" >&2
  echo "$out" >&2
  exit 1
fi
grep -q "links the plugin crate 'opensesame-surrogate-proxy'" <<<"$out" || {
  echo "plugin-boundary negative control: FAIL — the plugin crate was not named:" >&2
  echo "$out" >&2
  exit 1
}
grep -q "rcgen" <<<"$out" || {
  echo "plugin-boundary negative control: FAIL — rcgen was not named:" >&2
  echo "$out" >&2
  exit 1
}

bash "$gate" >/dev/null
echo "plugin-boundary negative control: OK"
