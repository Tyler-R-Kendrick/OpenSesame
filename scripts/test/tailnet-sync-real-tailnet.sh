#!/usr/bin/env bash
# Tailnet vault sync over a real tailnet (ADR 0144). verify:tailnet-sync, but
# the drive is reached the way a person's browser reaches it: by its MagicDNS
# name, over WireGuard, through `tailscale serve` on the drive's machine.
#
#   desk   tailscaled (userspace) — the drive: `opensesame daemon run` on
#          loopback, a TLS terminator in front of it, and `tailscale serve
#          --tcp=443` forwarding the tailnet's 443 to that terminator
#   phone  tailscaled with a kernel TUN — the browser's machine: Chromium
#          resolves desk.<tailnet>.ts.net to desk's 100.x address and the
#          packets leave through the TUN, so Chrome classes the address itself
#          and its Local Network Access gate is the real one
#
# Control is a local headscale. Tailscale's own control plane would issue
# Serve a publicly trusted certificate; headscale cannot, so TLS is terminated
# by the verifier's own (browser-trusted) certificate and Serve forwards TCP.
# That is the one difference from a person's tailnet, and it is in the
# certificate's issuer, not the path.
#
# Needs /dev/net/tun and CAP_NET_ADMIN (a root container is enough). Fails,
# never skips, when they are missing. Binaries are fetched once into
# .cache/tailnet-fixtures/ and checked against the sha256 pins below, which
# match upstream's published checksums:
#   tailscale_1.102.4_amd64.tgz     pkgs.tailscale.com/…/tailscale_1.102.4_amd64.tgz.sha256
#   headscale_0.27.1_linux_amd64    github.com/juanfont/headscale v0.27.1 checksums.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TS_VERSION="1.102.4"
TS_SHA256="50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9"
HS_VERSION="0.27.1"
HS_SHA256="af2a232ff407c100f05980b4d8fceaafc7fdb2e8de5eba8e184a8bb029cb6c00"
CACHE="${ROOT}/.cache/tailnet-fixtures"
TAILNET="tail4c2e.ts.net"
HS_PORT="${TAILNET_HS_PORT:-18080}"
TLS_PORT="${TAILNET_TLS_PORT:-18443}"
TUN="ts-sync0"

say() { echo "tailnet-sync-real: $*"; }
fail() { echo "tailnet-sync-real: $*" >&2; exit 1; }

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] || fail "needs linux/amd64"
[[ -c /dev/net/tun ]] || fail "no /dev/net/tun: the phone node needs a kernel TUN"
[[ "$(id -u)" == "0" ]] || fail "needs CAP_NET_ADMIN for the TUN (run in a root container)"

fetch() { # url file sha256
  if [[ ! -f "$2" ]] || [[ "$(sha256sum "$2" | awk '{print $1}')" != "$3" ]]; then
    curl -fsSL -o "$2.part" "$1"
    [[ "$(sha256sum "$2.part" | awk '{print $1}')" == "$3" ]] || fail "sha256 mismatch: $1"
    mv "$2.part" "$2"
  fi
}
mkdir -p "$CACHE"
fetch "https://pkgs.tailscale.com/stable/tailscale_${TS_VERSION}_amd64.tgz" \
  "$CACHE/tailscale.tgz" "$TS_SHA256"
fetch "https://github.com/juanfont/headscale/releases/download/v${HS_VERSION}/headscale_${HS_VERSION}_linux_amd64" \
  "$CACHE/headscale" "$HS_SHA256"
chmod +x "$CACHE/headscale"
tar -xzf "$CACHE/tailscale.tgz" -C "$CACHE"
TS_BIN="$CACHE/tailscale_${TS_VERSION}_amd64"

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Nothing on the tailnet goes through an outbound proxy a sandbox may set. An
# array, not a function, so `$!` of a background start is the process itself.
DIRECT=(env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u ALL_PROXY -u all_proxy NO_PROXY='*')
direct() { "${DIRECT[@]}" "$@"; }

# Control: headscale, allow-all, no relay (both nodes reach each other directly).
mkdir -p "$WORK/hs"
cat >"$WORK/hs/derp.yaml" <<'EOF'
regions:
  900:
    regionid: 900
    regioncode: none
    regionname: none
    nodes:
      - name: 900a
        regionid: 900
        hostname: derp.invalid
        ipv4: 127.0.0.1
        stunport: -1
        derpport: 9
EOF
echo '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}' >"$WORK/hs/policy.json"
cat >"$WORK/hs/config.yaml" <<EOF
server_url: http://127.0.0.1:${HS_PORT}
listen_addr: 127.0.0.1:${HS_PORT}
metrics_listen_addr: 127.0.0.1:0
grpc_listen_addr: 127.0.0.1:0
noise:
  private_key_path: $WORK/hs/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls: []
  paths: [$WORK/hs/derp.yaml]
  auto_update_enabled: false
disable_check_updates: true
database:
  type: sqlite
  sqlite:
    path: $WORK/hs/db.sqlite
policy:
  mode: file
  path: $WORK/hs/policy.json
dns:
  magic_dns: true
  base_domain: ${TAILNET}
  override_local_dns: false
  nameservers:
    global: []
unix_socket: $WORK/hs/headscale.sock
unix_socket_permission: "0700"
EOF
HS=("$CACHE/headscale" -c "$WORK/hs/config.yaml")
"${DIRECT[@]}" "${HS[@]}" serve >"$WORK/hs/log" 2>&1 &
PIDS+=($!)
for _ in $(seq 60); do
  direct curl -fsS "http://127.0.0.1:${HS_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.5
done
direct curl -fsS "http://127.0.0.1:${HS_PORT}/health" >/dev/null || fail "headscale did not start"
direct "${HS[@]}" users create sync >/dev/null
KEY="$(direct "${HS[@]}" preauthkeys create --user 1 --reusable --expiration 1h 2>/dev/null | tail -1)"

node_up() { # name tun extra-up-flags...
  local name="$1" tun="$2"
  shift 2
  mkdir -p "$WORK/$name"
  "${DIRECT[@]}" "$TS_BIN/tailscaled" --tun="$tun" --statedir="$WORK/$name" \
    --socket="$WORK/$name/sock" --port=0 >"$WORK/$name/log" 2>&1 &
  PIDS+=($!)
  sleep 2
  direct "$TS_BIN/tailscale" --socket="$WORK/$name/sock" up \
    --login-server="http://127.0.0.1:${HS_PORT}" --authkey="$KEY" \
    --hostname="$name" --accept-dns=false "$@"
}
ts() { local name="$1"; shift; direct "$TS_BIN/tailscale" --socket="$WORK/$name/sock" "$@"; }

node_up desk userspace-networking
node_up phone "$TUN" --netfilter-mode=off
DESK="$(ts desk ip -4)"
say "desk ${DESK}, phone $(ts phone ip -4), tun ${TUN}"

# A path both ways: the phone's packets reach desk and desk's replies reach it.
for _ in $(seq 30); do
  if ts phone ping --tsmp -c 1 --timeout 2s "$DESK" >/dev/null 2>&1 &&
    ts desk ping -c 1 --timeout 2s "$(ts phone ip -4)" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
ts phone ping --tsmp -c 1 --timeout 3s "$DESK" || fail "no WireGuard path from phone to desk"
ts phone status

ts desk serve --bg --tcp=443 "tcp://127.0.0.1:${TLS_PORT}"
say "desk serves desk.${TAILNET}:443 → 127.0.0.1:${TLS_PORT}"

TAILNET_SYNC_TAILNET="desk.${TAILNET},${TLS_PORT},${DESK}" \
  node apps/pages/scripts/verify-tailnet-sync.mjs
