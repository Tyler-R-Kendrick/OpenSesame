# ADR 0148 — The Bitwarden server as an optional bridge, and moving onto it

- Status: Accepted
- Date: 2026-09-28
- Builds on: [ADR 0141](0141-bitwarden-compatible-server.md) (the
  Bitwarden-compatible server), [ADR 0052](0052-password-manager-ecosystem-bridging.md)
  and [ADR 0053](0053-pm-bridge-binaries.md) (password-manager bridges, one
  cargo feature each, all off by default)

## Context

ADR 0141 made the Host answer Bitwarden's clients. Two things were missing
for it to replace a Bitwarden or vaultwarden server:

1. **It was compiled into every Host.** The other password-manager bridges
   are cargo features that a default build leaves out (ADR 0053 §6); the
   Bitwarden server was a plain dependency of the gateway, gated only by an
   environment variable. A Host that never serves Bitwarden clients still
   shipped the code.
2. **Nothing moved an existing server's people onto it.** The only road was
   "export the vault from the old server and `bw import` it": one person at a
   time, with the vault decrypted into a file on the way, a new master
   password, and no folders' or trash's history. ADR 0141 §4 anticipated an
   importer and shipped none.

## Decision

### 1. A bridge, compiled on request

The Bitwarden server is the `bitwarden-compat` cargo feature of
`opensesame-gateway` and `opensesame-cli`, off by default, like every bridge
in `crates/pm-bridges`. Serving it takes both switches: a Host built with
`--features bitwarden-compat` and `OPENSESAME_BITWARDEN_COMPAT=on`. A Host
built without the feature that is told to serve it refuses to start; it never
comes up quietly without a surface its operator configured. The container
image takes the list as a build argument (`OPENSESAME_FEATURES`), and CI
builds and tests the feature beside the default build.

## Consequences

- A default Host build contains no Bitwarden code. Operators who serve
  Bitwarden clients build with the feature, as they do for any bridge.
