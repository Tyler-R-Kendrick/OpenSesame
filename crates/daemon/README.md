# opensesame-daemon

The local host agent on the Host/authority plane, served by `opensesame daemon run`,
listening on `127.0.0.1:18790` and optionally on a Unix socket. It hands out
short-lived session capabilities to devcontainers, WSL, `opensesame daemon` and the
credential helpers, discovers connectors on this machine without reading their
values, and proxies to the Host and Identity APIs. It never dumps refresh
tokens or WebAuthn material.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`opensesame daemon run|install|start|status|logs|stop|info|approve-device|approve-claim|drive|fill|tailnet`),
  [`crates/credential-helpers`](../credential-helpers)
  (`POST /v1/mint` over the socket), [`packages/mcp-host`](../../packages/mcp-host) and
  [`apps/browser-extension`](../../apps/browser-extension) (health probe).
- **Builds on:** [`opensesame-host-core`](../../crates/host-core) (listen policy,
  the endpoint table, the operator-token check),
  [`opensesame-connection-detect`](../../crates/connection-detect) (discovery),
  [`opensesame-invoke-through`](../../crates/invoke-through),
  [`opensesame-uds-authn`](../../crates/uds-authn),
  [`opensesame-sealed-store`](../../crates/sealed-store) (fill by reference),
  [`opensesame-plugin-settings`](../../crates/plugin-settings) (the plugin
  catalog and switch behind `/v1/plugins` and `/v1/fill`),
  [`opensesame-tailnet-admin`](../../crates/tailnet-admin) (`/v1/tailnet/*`) and,
  behind a feature, [`opensesame-tailscale-authn`](../../crates/tailscale-authn).
- Operator routes need the operator token (`X-OpenSesame-Operator` or
  `Authorization: Bearer operator:<token>`, from `OPENSESAME_OPERATOR_TOKEN`) on
  every transport, and a browser `Origin` header is refused. Over the Unix socket
  the kernel-attested peer UID is an additional restriction, never a substitute
  (`OPENSESAME_DAEMON_ALLOWED_UIDS`, default same user). `/v1/plugins*` also
  accept the bearer a page traded a pairing code for, from the exact origin it
  was paired at; `/v1/tailnet/*` accept only that bearer, with the role the route
  needs.
- The daemon's own direct dependencies are budgeted: `pnpm audit:daemon-deps`
  refuses a database, OAuth, JWT, AEAD, task-bus or Wasm-engine crate among
  them, holds the `invoke-through`, `uds-authn` and `tailscale-authn` trees to
  the same list and the `connection-detect` tree to a fixed allowlist
  ([ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) §5).
  The tree below `host-core` is not constrained. OS keychains are enumerated by
  label only.

## Surface

Flags (each also an env var): `--listen` (`OPENSESAME_DAEMON_LISTEN`),
`--sock` (`OPENSESAME_AGENT_SOCK`), `--host-api` (`OPENSESAME_HOST_API`,
default `http://127.0.0.1:8787`), `--identity-api` (`OPENSESAME_IDENTITY_API`,
default `http://127.0.0.1:8788`), `--allowed-uids`
(`OPENSESAME_DAEMON_ALLOWED_UIDS`). Cargo feature `tailscale` (default off) adds
a read-only tailnet listener (`/health`, `/v1/discover` and the vault drive's
device routes, behind a `whois` gate); `tailnet-admin-test-upstream` is for the
end-to-end harness only.

| Route group | Paths |
|---|---|
| Health | `/health`, `/health/live` |
| Sessions and capabilities | `/v1/list_sessions`, `/v1/get_access_token`, `/v1/mint_capability`, `/v1/introspect_capability`, `/v1/revoke`, `/v1/agent-capabilities/token` |
| Discovery and promotion | `/v1/discover` (rate-limited), `/v1/promote` |
| Brokered calls | `/v1/invoke_through`, `/v1/mint` (forwards to the gateway's connection mint) |
| Toolbar | `/v1/toolbar/status`, `/v1/toolbar/approve_device`, `/v1/toolbar/approve_claim`, `/v1/operator/invoke_l1` |
| Vault drive (ADR 0144) | `/v1/vault-drive/slots` (operator: open, list), `/v1/vault-drive/slots/{slot}` (operator: close), `/v1/vault-drive/slots/{slot}/snapshot` (slot key: read, compare-and-set replace; also on the tailnet listener) |
| Vault drive parts (ADR 0144) | `/v1/vault-drive/slots/{slot}/parts` (list), `/v1/vault-drive/slots/{slot}/parts/{part}` (read, write); slot key, like the snapshot |
| Plugins (ADR 0150 §7) | `/v1/plugins` (list), `/v1/plugins/{id}` (switch on or off), `/v1/plugins/{id}/notices`, `/v1/plugins/pairing` (exchange, revoke) |
| Tailnet devices (ADR 0169) | `/v1/tailnet/pairing`, `/v1/tailnet/status`, `/v1/tailnet/devices[/{id}[/authorized\|name\|tags\|key-expiry\|expire\|routes]]`, `/v1/tailnet/keys[/{id}]`, `/v1/tailnet/audit`; a paired page's bearer, by role |
| Proxies | `/host/*` to the Host API, `/identity/*` to the Identity API |
| Duress peer | `/v1/duress/peer/health`, `/v1/duress/peer/envelope` |
| Autofill (ADR 0150 §6.4; the optional `browser-autofill` plugin) | `/v1/fill` (one field, exact origin, rate-limited), `/v1/fill/match` (entry names only), `/v1/fill/pair` (the companion extension, from its own origin), `/v1/fill/pair/approve`, `/v1/fill/pair/revoke`, `/v1/fill/pairings` (operator). Every one answers like a path never served (404, no body) unless `browser-autofill` is installed and switched on in the plugin settings file; see [`apps/browser-extension-autofill`](../../apps/browser-extension-autofill) |

Source areas under `src/`: `discovery.rs`, `keychain.rs`, `cli_probe.rs`,
`runner.rs` (scrubbed command execution), `promote.rs`, `invoke_through.rs`,
`token_source.rs`, `mint.rs`, `peer_auth.rs`, `agent_capability.rs`,
`startup.rs` (validation before any listener starts), `tailnet.rs`,
`tailscale.rs`, `duress_receiver/`, `fill/`, `vault_drive*.rs`, `plugin_*.rs`,
`tailnet_admin_*.rs`, `toolbar.rs`, `ratelimit.rs`.

## Develop

```bash
cargo +1.88.0 test -p opensesame-daemon
cargo +1.88.0 test -p opensesame-daemon --features tailscale
cargo +1.88.0 run -p opensesame-cli -- daemon run --help
pnpm audit:daemon-deps
```

Wire shapes of the refusal and success responses are pinned as `insta`
snapshots in `src/snapshots/`; a change to a response body shows up there.

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology
- [ADR 0047](../../docs/adr/0047-daemon-connector-discovery.md), [ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) — connector discovery, UDS and tailnet authentication
- [ADR 0049](../../docs/adr/0049-derived-short-lived-materialization.md) — mint passthrough
- [ADR 0099](../../docs/adr/0099-scoped-local-agent-authority.md) — scoped local agent authority
- [Reference: daemon socket](../../docs/reference/daemon-socket.md), [operators: local](../../docs/operators/local.md)
