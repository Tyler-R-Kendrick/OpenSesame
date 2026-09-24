# opensesame-pm-bridges

Local-IPC bridges on the Host/authority plane that let foreign
password-manager clients — the browserpass, gopassbridge and KeePassXC-Browser
extensions — read the OpenSesame sealed store unchanged. Each bridge answers a
local caller with a credential in the clear, so each is a human/device-plane
surface only: same local user, one explicit human approval per caller, never
reachable from the agent plane. Every serving surface is a cargo feature of
`opensesame`, off by default; `opensesame` answers as a bridge when started
under its name.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`opensesame bridge …` installs
  native-messaging manifests, probes the KeePassXC socket, opens the pairing
  window) through the library's `conflict`, `manifest` and `now_unix`.
- **Builds on:** [`opensesame-sealed-store`](../../crates/sealed-store) only;
  `crypto_box` for the `keepassxc` feature.
- No network listener. A native-messaging host speaks over the stdio pipe the
  browser gave it; the KeePassXC socket lives under `$XDG_RUNTIME_DIR`.
  Nothing here is an MCP tool, a WIT import or a `ConnectionRef` operation.
- Failure discipline follows [`crates/credential-helpers`](../credential-helpers):
  non-zero exit, only a well-formed protocol error on stdout, only a failure
  class on stderr.

## Surface

| Cargo feature | Name | Protocol |
|---|---|---|
| `browserpass` | `opensesame-browserpass-host` | browserpass native messaging: `configure`, `list`, `fetch`, `echo`; no write verbs |
| `gopass` | `opensesame-gopass-jsonapi` | gopass-jsonapi native messaging (`query`, `queryHost`, …) |
| `keepassxc` | `opensesame-keepassxc-bridge` | keepassxc-protocol, as a native host or `serve [--socket PATH] [--takeover]` on the socket `keepassxc-proxy` dials |
| `secret-service`, `webdav` | — | Declared; nothing is gated on them yet |

A default build compiles only the shared library: `framing` (native-messaging
stdio framing), `store` (`StoreAccess`, URL search), `pairing` (public keys and
metadata only), `conflict` (singleton endpoint probing), `manifest` (per-browser
host manifests), and `keepassxc` behind its feature. KeePassXC `associate` is
refused unless a human opened a pairing window with
`opensesame bridge keepassxc pair` and confirmed the key fingerprint.

Environment: `OPENSESAME_STORE_PASSWORD` (a native host has no TTY),
`OPENSESAME_BRIDGE_STORE_DIR` (else `OPENSESAME_STORE_DIR`,
`PASSWORD_STORE_DIR`, `~/.password-store`), `OPENSESAME_BRIDGES_DIR`.

## Develop

```bash
cargo +1.88.0 test -p opensesame-pm-bridges
cargo +1.88.0 test -p opensesame-pm-bridges --features browserpass,gopass,keepassxc
cargo +1.88.0 test -p opensesame-cli --features browserpass,gopass   # golden suites
cargo +1.88.0 build -p opensesame-cli --features keepassxc              # ship a bridge
```

The golden suites drive `opensesame` under each bridge's name and live in
[`apps/cli/tests`](../../apps/cli/tests); the handshake suite stays here. Each
compiles only with its feature on. `keepassxc_handshake.rs` runs real `crypto_box` operations over a
temporary Unix socket; its replies are pinned as `insta` snapshots in
`tests/snapshots/`.

## Related

- [ADR 0052](../../docs/adr/0052-password-manager-ecosystem-bridging.md) — password-manager ecosystem bridging
- [ADR 0053](../../docs/adr/0053-pm-bridge-binaries.md) — the bridge binaries
- [Architecture: pm-bridges](../../docs/architecture/pm-bridges.md)
