#!/usr/bin/env bash
# Proxied run, end to end (ADR 0150): `opensesame dev run --agent` with the
# surrogate-proxy plugin, a token sealed by `opensesame pass insert`, and a
# child that reaches the provider only through the run's proxy.
#
# What it drives is apps/cli/tests/proxied_run_e2e.rs,
# proxied_run_refusals.rs and proxied_run_signals.rs (how a run ends when
# `opensesame` is signalled): the real `opensesame` binary; the plugin's TEST build
# (cargo feature `upstream-override`: a loopback upstream and a banner),
# installed through `opensesame plugins install` with its sha256 pin; the real
# @env-spec/parser; and a recording TLS server standing in for api.vercel.com.
# A shipped plugin build has no such door, and
# crates/surrogate-proxy/tests/shipped_build.rs holds it to that. This script
# copies the test build out of the shared target directory the moment it is
# built, so a later build of the shipped flavour cannot swap it, and only each
# test's own sandbox ever installs it.
#
# Needs: cargo (+1.88.0), node, git, and a resolvable @env-spec/parser, one of
#   - `pnpm install` having run (packages/env-spec-bridge/node_modules), or
#   - OPENSESAME_E2E_ENVSPEC_DIR naming a directory that holds
#     node_modules/@env-spec/parser (any package manager's layout will do).
#     NODE_PATH cannot stand in: the bridge is an ES module, and ES module
#     resolution ignores it.
# Fails, never skips, when a piece is missing. Extra arguments go to the test
# binary (a test name filters it).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "proxied-run: $*" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v node >/dev/null || fail "node is required"
command -v git >/dev/null || fail "git is required (the sealed store is a git repository)"

# 1. The plugin's test build, copied before anything else can rebuild the
#    shared binary of the same name.
echo "proxied-run: building the plugin's test build"
built="$(cargo +1.88.0 build -q -p opensesame-surrogate-proxy \
  --features upstream-override --bin opensesame-surrogate-proxy \
  --message-format=json-render-diagnostics \
  | node -e '
      let out = "";
      process.stdin.on("data", (d) => (out += d));
      process.stdin.on("end", () => {
        const found = out.split("\n").filter(Boolean).map((l) => JSON.parse(l))
          .filter((m) => m.reason === "compiler-artifact" && m.executable
            && m.target.name === "opensesame-surrogate-proxy");
        if (!found.length) process.exit(1);
        process.stdout.write(found[found.length - 1].executable);
      });')" || fail "cargo did not report the plugin binary"
plugin="$WORK/opensesame-surrogate-proxy"
cp "$built" "$plugin"
grep -q "OPENSESAME_SURROGATE_TEST_UPSTREAM" "$plugin" \
  || fail "$built is not the test build (no upstream override in its bytes)"
export OPENSESAME_E2E_PLUGIN_BIN="$plugin"

# 2. A bridge that can resolve @env-spec/parser.
bridge="$ROOT/packages/env-spec-bridge"
if [[ -d "$bridge/node_modules/@env-spec/parser" ]]; then
  echo "proxied-run: using $bridge/node_modules"
elif [[ -n "${OPENSESAME_E2E_ENVSPEC_DIR:-}" ]]; then
  [[ -d "$OPENSESAME_E2E_ENVSPEC_DIR/node_modules/@env-spec/parser" ]] \
    || fail "$OPENSESAME_E2E_ENVSPEC_DIR/node_modules/@env-spec/parser does not exist"
  mkdir -p "$WORK/bridge"
  cp "$bridge/bin/opensesame-env-parse.mjs" "$WORK/bridge/"
  ln -s "$OPENSESAME_E2E_ENVSPEC_DIR/node_modules" "$WORK/bridge/node_modules"
  export OPENSESAME_E2E_ENV_PARSE="$WORK/bridge/opensesame-env-parse.mjs"
  echo "proxied-run: using $OPENSESAME_E2E_ENVSPEC_DIR/node_modules"
else
  fail "no @env-spec/parser: run pnpm install, or set OPENSESAME_E2E_ENVSPEC_DIR to a directory holding node_modules/@env-spec/parser"
fi

# 3. The tests. `--include-ignored` because a plain `cargo test` has neither piece.
echo "proxied-run: running apps/cli/tests/proxied_run_{e2e,refusals,signals}.rs"
cargo +1.88.0 test -p opensesame-cli --test proxied_run_e2e --test proxied_run_refusals \
  --test proxied_run_signals -- --include-ignored "$@"
echo "proxied-run: OK"
