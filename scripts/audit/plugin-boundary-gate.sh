#!/usr/bin/env bash
# Plugin boundary gate (ADR 0150 §7, ADR 0048 §5).
#
# Optional plugins are installed at runtime, never shipped: the default
# `opensesame` binary (opensesame-cli) and the daemon (opensesame-daemon) must
# not reach a plugin crate through a normal dependency edge, with default
# features or any feature the daemon offers.
#
#   (a) No target's normal tree contains a plugin-only crate
#       (opensesame-surrogate-proxy).
#   (b) rcgen, the certificate minting the surrogate proxy needs, is not in the
#       daemon's tree at all. The CLI already reaches rcgen through the Host
#       role's PKI (opensesame-gateway, opensesame-pki-core, instant-acme);
#       those are its only permitted parents, so a new path — the proxy, or
#       anything else — fails.
#
# PLUGIN_BOUNDARY_TARGETS replaces the target list; the negative control
# (scripts/test/plugin-boundary-negative-control.sh) points it at the plugin
# crate itself and requires this gate to FAIL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

PLUGIN_CRATES=(opensesame-surrogate-proxy)
RCGEN_PARENTS_ALLOWED=(opensesame-gateway opensesame-pki-core instant-acme)

# label|cargo tree args|rcgen policy (none = absent; parents = allowlisted parents only)
DEFAULT_TARGETS=(
  "opensesame-cli|-p opensesame-cli|parents"
  "opensesame-daemon|-p opensesame-daemon|none"
  "opensesame-daemon (tailscale)|-p opensesame-daemon --features tailscale|none"
)
if [[ -n "${PLUGIN_BOUNDARY_TARGETS:-}" ]]; then
  read -r -a names <<<"$PLUGIN_BOUNDARY_TARGETS"
  TARGETS=()
  for name in "${names[@]}"; do TARGETS+=("$name|-p $name|none"); done
else
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

fail=0

tree_names() { # $1: cargo tree args
  # shellcheck disable=SC2086
  cargo tree $1 -e normal --prefix none 2>/dev/null | awk '{print $1}' | sort -u
}

rcgen_parents() { # $1: cargo tree args, $2: rcgen version
  # shellcheck disable=SC2086
  cargo tree $1 -e normal -i "rcgen@$2" --depth 1 --prefix none 2>/dev/null \
    | awk '{print $1}' | grep -vx rcgen | sort -u
}

for target in "${TARGETS[@]}"; do
  IFS='|' read -r label args policy <<<"$target"
  # shellcheck disable=SC2086
  if ! full="$(cargo tree $args -e normal --prefix none 2>&1)"; then
    echo "plugin-boundary gate: FAIL — cargo tree failed for $label:" >&2
    echo "$full" >&2
    fail=1
    continue
  fi
  names="$(tree_names "$args")"
  for plugin in "${PLUGIN_CRATES[@]}"; do
    if grep -qx "$plugin" <<<"$names"; then
      echo "plugin-boundary gate: FAIL — $label links the plugin crate '$plugin'" >&2
      fail=1
    fi
  done
  versions="$(awk '$1 == "rcgen" {print $2}' <<<"$full" | tr -d 'v' | sort -u)"
  [[ -z "$versions" ]] && continue
  if [[ "$policy" == "none" ]]; then
    echo "plugin-boundary gate: FAIL — rcgen ($(tr '\n' ' ' <<<"$versions")) reachable in $label" >&2
    fail=1
    continue
  fi
  for version in $versions; do
    unexpected="$(comm -23 <(rcgen_parents "$args" "$version") \
      <(printf '%s\n' "${RCGEN_PARENTS_ALLOWED[@]}" | sort -u))"
    if [[ -n "$unexpected" ]]; then
      echo "plugin-boundary gate: FAIL — rcgen@$version reaches $label through:" >&2
      echo "$unexpected" >&2
      fail=1
    fi
  done
done

if [[ "$fail" -ne 0 ]]; then
  echo "  (ADR 0150 §7: a plugin ships as its own executable, installed at runtime;" >&2
  echo "   the default binary and the daemon never link it)" >&2
  echo "plugin-boundary gate: FAIL" >&2
  exit 1
fi
echo "plugin-boundary gate: CLEAN"
