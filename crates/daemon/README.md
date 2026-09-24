# opensesame-daemon

The local host agent on the Host/authority plane, served by `opensesame daemon run`,
listening on `127.0.0.1:18790` and optionally on a Unix socket. It hands out
short-lived session capabilities to devcontainers, WSL, `opensesame daemon` and the
credential helpers, discovers connectors on this machine without reading their
values, and proxies to the Host and Identity APIs. It never dumps refresh
tokens or WebAuthn material.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli) (`opensesame daemon run|start|status|logs|stop|info|approve-device|approve-claim`),
  [`crates/credential-helpers`](../credential-helpers)
  (`POST /v1/mint` over the socket), [`packages/mcp-host`](../../packages/mcp-host) and
  [`apps/browser-extension`](../../apps/browser-extension) (health probe).
- **Builds on:** [`opensesame-host-core`](../../crates/host-core) (listen policy,
  `DEFAULT_LISTEN`), [`opensesame-connection-detect`](../../crates/connection-detect)
  (discovery), [`opensesame-invoke-through`](../../crates/invoke-through),
  [`opensesame-uds-authn`](../../crates/uds-authn) and, behind a feature,
  [`opensesame-tailscale-authn`](../../crates/tailscale-authn).
- Mutating routes need the operator token (`X-OpenSesame-Operator`) on TCP;
  over the Unix socket the kernel-attested peer UID authenticates instead
  (`OPENSESAME_DAEMON_ALLOWED_UIDS`, default same user).
- The dependency closure is budgeted: no database, OAuth, JWT, AEAD or task-bus
  crates ([ADR 0048](../../docs/adr/0048-capability-moded-connector-discovery.md) §5,
  `pnpm audit:daemon-deps`). OS keychains are enumerated by label only.

## Surface

Flags (each also an env var): `--listen` (`OPENSESAME_DAEMON_LISTEN`),
`--sock` (`OPENSESAME_AGENT_SOCK`), `--host-api` (`OPENSESAME_HOST_API`,
default `http://127.0.0.1:8787`), `--identity-api` (`OPENSESAME_ISSUER`,
default `http://127.0.0.1:8788`), `--allowed-uids`. Cargo feature
`tailscale` (default off) adds a read-only tailnet listener.

| Route group | Paths |
|---|---|
| Health | `/health`, `/health/live` |
| Sessions and capabilities | `/v1/list_sessions`, `/v1/get_access_token`, `/v1/mint_capability`, `/v1/introspect_capability`, `/v1/revoke`, `/v1/agent-capabilities/token` |
| Discovery and promotion | `/v1/discover` (rate-limited), `/v1/promote` |
| Brokered calls | `/v1/invoke_through`, `/v1/mint` (forwards to the gateway's connection mint) |
| Toolbar | `/v1/toolbar/status`, `/v1/toolbar/approve_device`, `/v1/toolbar/approve_claim`, `/v1/operator/invoke_l1` |
| Proxies | `/host/*` to the Host API, `/identity/*` to the Identity API |
| Duress peer | `/v1/duress/peer/health`, `/v1/duress/peer/envelope` |

Source areas under `src/`: `discovery.rs`, `keychain.rs`, `cli_probe.rs`,
`runner.rs` (scrubbed command execution), `promote.rs`, `invoke_through.rs`,
`token_source.rs`, `mint.rs`, `peer_auth.rs`, `agent_capability.rs`,
`startup.rs` (validation before any listener starts), `tailnet.rs`,
`tailscale.rs`, `duress_receiver/`.

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
