#!/usr/bin/env bash
# Daemon dependency-budget gate (ADR 0048 §5).
#
# The discovery stack deliberately ships a minimal dependency closure onto a
# loopback agent. This gate pins that closure and refuses the credential-
# exchange surface (database, OAuth, JWT, AEAD, task bus) anywhere near the
# daemon's direct dependencies or the new discovery crates' full trees:
#
#   (a) opensesame-connection-detect's entire tree must be a subset of the
#       allowlist below — serde + serde_json + thiserror + std was the ADR
#       budget, and every transitive entry is accounted for.
#   (b) sqlx / oauth2 / jsonwebtoken / chacha20poly1305 / task-bus must not
#       appear in the daemon's direct dependencies (manifest AND resolved
#       depth-1 tree, with and without --features tailscale) nor anywhere in
#       the invoke-through / tailscale-authn / uds-authn trees.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0

names() { # $1: cargo tree args
  # shellcheck disable=SC2086
  cargo tree $1 --prefix none 2>/dev/null | awk '{print $1}' | sort -u
}

# ——— (a) connection-detect closure —————————————————————————————————
# Allowlist, built from `cargo tree -p opensesame-connection-detect`:
ALLOWED_DETECT=(
  opensesame-connection-detect # the crate itself
  serde                        # offer model (contract C1)
  serde_core                   # serde's runtime half (1.0.219 split)
  serde_derive                 # serde's derive half
  serde_json                   # MCP config parsing + offer wire format
  itoa                         # serde_json: integer formatting
  memchr                       # serde_json: byte scanning
  zmij                         # serde_json: float formatting (ryu successor)
  thiserror                    # ProbeError (contract C2)
  thiserror-impl               # thiserror's derive half
  proc-macro2                  # derive-macro transitive
  quote                        # derive-macro transitive
  syn                          # derive-macro transitive
  unicode-ident                # proc-macro2 transitive
)

actual="$(names "-p opensesame-connection-detect")"
unexpected="$(comm -23 <(echo "$actual") <(printf '%s\n' "${ALLOWED_DETECT[@]}" | sort -u))"
if [[ -n "$unexpected" ]]; then
  echo "daemon-deps gate: FAIL — connection-detect tree gained dependencies:" >&2
  echo "$unexpected" >&2
  echo "  (ADR 0048 §5 budgets serde + serde_json + thiserror + std; widen the" >&2
  echo "   allowlist in scripts/daemon-deps-gate.sh only by amending the ADR)" >&2
  fail=1
fi

# ——— (b) credential-exchange surface must stay off the daemon ————————————
BANNED=(sqlx oauth2 jsonwebtoken chacha20poly1305 task-bus)

check_tree() { # $1: label, $2: cargo tree args
  local tree banned
  tree="$(names "$2")"
  for banned in "${BANNED[@]}"; do
    if grep -q "$banned" <<<"$tree"; then
      echo "daemon-deps gate: FAIL — '$banned' reachable in $1:" >&2
      grep "$banned" <<<"$tree" >&2
      fail=1
    fi
  done
}

# Direct dependencies per the manifest (kind = normal, any target), which
# catches a banned crate even on platforms this host does not resolve.
manifest_banned="$(cargo metadata --format-version 1 --no-deps 2>/dev/null \
  | python3 -c '
import json, sys
banned = sys.argv[1:]
meta = json.load(sys.stdin)
pkg = next(p for p in meta["packages"] if p["name"] == "opensesame-daemon")
hits = sorted(
    d["name"] for d in pkg["dependencies"] if d["kind"] is None
    for b in banned if b in d["name"]
)
print("\n".join(hits))
' "${BANNED[@]}")"
if [[ -n "$manifest_banned" ]]; then
  echo "daemon-deps gate: FAIL — banned direct dependency in apps/daemon/Cargo.toml:" >&2
  echo "$manifest_banned" >&2
  fail=1
fi

# Resolved depth-1 (direct) daemon tree, default and tailscale features.
check_tree "opensesame-daemon (depth 1)" "-p opensesame-daemon --depth 1"
check_tree "opensesame-daemon (depth 1, tailscale)" "-p opensesame-daemon --depth 1 --features tailscale"

# The new discovery crates must never pull the surface in at any depth.
check_tree "opensesame-invoke-through" "-p opensesame-invoke-through"
check_tree "opensesame-tailscale-authn" "-p opensesame-tailscale-authn"
check_tree "opensesame-uds-authn" "-p opensesame-uds-authn"

if [[ "$fail" -ne 0 ]]; then
  echo "daemon-deps gate: FAIL" >&2
  exit 1
fi
echo "daemon-deps gate: CLEAN"
