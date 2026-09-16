#!/usr/bin/env bash
# Disposable Blocky instance for the DNS enforcement protocol tests.
#
# Builds the pinned Blocky release, writes a throwaway config with two isolated
# enforcement units, starts it on high ports, and prints the environment the
# tests read. Everything lives under a temporary root, nothing is installed
# system-wide, and no step needs elevation.
#
#   eval "$(crates/dns-enforcement/harness/blocky-env.sh up)"
#   cargo +1.88.0 test -p opensesame-dns-enforcement --test blocky_protocol
#   crates/dns-enforcement/harness/blocky-env.sh probe-isolation
#   crates/dns-enforcement/harness/blocky-env.sh down
#
# The version is injected with the same ldflag Blocky's own Makefile uses, so
# `blocky version` reports the pin rather than "undefined" — a binary that cannot
# tell you what it is cannot back a claim about what it does.

set -euo pipefail

BLOCKY_VERSION="${BLOCKY_VERSION:-v0.35.0}"
ROOT="${BLOCKY_ENV_ROOT:-/tmp/opensesame-blocky-env}"
HTTP_PORT="${BLOCKY_HTTP_PORT:-54780}"
DNS_PORT="${BLOCKY_DNS_PORT:-55353}"
# Deliberately dead: these tests are about the filter's decision, and a real
# upstream would make "allowed" depend on the network instead of on the list.
UPSTREAM="${BLOCKY_UPSTREAM:-127.0.0.1:55999}"

BIN="$ROOT/bin/blocky"
PIDFILE="$ROOT/blocky.pid"
API="http://127.0.0.1:$HTTP_PORT"

log() { printf '%s\n' "$*" >&2; }

build() {
  if [ -x "$BIN" ] && "$BIN" version 2>/dev/null | grep -q "$BLOCKY_VERSION"; then
    log "blocky $BLOCKY_VERSION already built at $BIN"
    return
  fi
  command -v go >/dev/null 2>&1 || {
    log "ERROR: go is not on PATH, so the pinned Blocky cannot be built."
    log "Install Go, or set BLOCKY_ENV_ROOT to a tree that already has bin/blocky."
    exit 1
  }
  log "building blocky $BLOCKY_VERSION (this takes a minute on a cold module cache)"
  mkdir -p "$ROOT/bin" "$ROOT/gopath"
  GOPATH="$ROOT/gopath" GOBIN="$ROOT/bin" go install \
    -ldflags "-X github.com/0xERR0R/blocky/util.Version=$BLOCKY_VERSION" \
    "github.com/0xERR0R/blocky@$BLOCKY_VERSION"
}

write_config() {
  mkdir -p "$ROOT/units/alpha" "$ROOT/units/beta"
  # unit-alpha denies two names; unit-beta denies one of its own plus the shared
  # one, so the isolation probe has something to disagree about.
  printf 'blocked.example.org\nboth.example.org\n' > "$ROOT/units/alpha/deny.txt"
  printf 'betaonly.example.org\nboth.example.org\n' > "$ROOT/units/beta/deny.txt"
  : > "$ROOT/units/alpha/allow.txt"
  : > "$ROOT/units/beta/allow.txt"

  # `default` maps to unit-alpha so POST /api/query — which arrives as the
  # server's own client — is deterministically alpha's view. 127.0.0.2 is bound
  # to unit-beta so a probe can compare the two from distinct source addresses.
  cat > "$ROOT/config.yml" <<YAML
ports:
  dns: $DNS_PORT
  http: $HTTP_PORT
upstreams:
  groups:
    default:
      - $UPSTREAM
blocking:
  blockType: zeroIP
  denylists:
    unit-alpha:
      - $ROOT/units/alpha/deny.txt
    unit-beta:
      - $ROOT/units/beta/deny.txt
  allowlists:
    unit-alpha:
      - $ROOT/units/alpha/allow.txt
    unit-beta:
      - $ROOT/units/beta/allow.txt
  clientGroupsBlock:
    default:
      - unit-alpha
    127.0.0.2:
      - unit-beta
log:
  level: warn
YAML
}

wait_for_api() {
  for _ in $(seq 1 40); do
    if curl -fsS -m 2 "$API/api/blocking/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  log "ERROR: blocky did not answer on $API within 20s; see $ROOT/blocky.log"
  exit 1
}

up() {
  build
  write_config
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    log "blocky already running (pid $(cat "$PIDFILE"))"
  else
    ( setsid "$BIN" --config "$ROOT/config.yml" > "$ROOT/blocky.log" 2>&1 & echo $! > "$PIDFILE" )
    wait_for_api
    log "blocky $BLOCKY_VERSION up on $API (dns :$DNS_PORT), pid $(cat "$PIDFILE")"
  fi

  log "binary sha256: $(sha256sum "$BIN" | cut -d' ' -f1)"
  log "self-reported:  $("$BIN" version 2>/dev/null | tr '\n' ' ')"

  # Printed on stdout so the caller can `eval` it.
  cat <<ENV
export OPENSESAME_BLOCKY_API=$API
export OPENSESAME_BLOCKY_ALLOWLIST=$ROOT/units/alpha/allow.txt
export OPENSESAME_BLOCKY_DENIED_NAME=both.example.org
export OPENSESAME_BLOCKY_GROUP=unit-alpha
ENV
}

down() {
  if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
    log "blocky stopped"
  else
    log "no pidfile at $PIDFILE; nothing to stop"
  fi
}

# Reproduces the isolation measurement the crate's design rests on: an allowance
# in unit-beta must not release a name unit-alpha denies. Needs real DNS queries
# from two source addresses, because /api/query is always one client.
probe_isolation() {
  local probe="$(dirname "$0")/dns-probe.py"
  : > "$ROOT/units/beta/allow.txt"
  curl -fsS -X POST "$API/api/lists/refresh" >/dev/null
  sleep 2

  log "--- baseline: both.example.org is denied by both units ---"
  python3 "$probe" both.example.org 127.0.0.1 "$DNS_PORT"
  python3 "$probe" both.example.org 127.0.0.2 "$DNS_PORT"

  log "--- allow both.example.org in unit-beta only ---"
  printf 'both.example.org\n' > "$ROOT/units/beta/allow.txt"
  curl -fsS -X POST "$API/api/lists/refresh" >/dev/null
  sleep 2
  log "expect: 127.0.0.1 (unit-alpha) still BLOCKED, 127.0.0.2 (unit-beta) released"
  python3 "$probe" both.example.org 127.0.0.1 "$DNS_PORT"
  python3 "$probe" both.example.org 127.0.0.2 "$DNS_PORT"

  : > "$ROOT/units/beta/allow.txt"
  curl -fsS -X POST "$API/api/lists/refresh" >/dev/null
}

case "${1:-up}" in
  up) up ;;
  down) down ;;
  probe-isolation) probe_isolation ;;
  *)
    log "usage: $0 {up|down|probe-isolation}"
    exit 2
    ;;
esac
