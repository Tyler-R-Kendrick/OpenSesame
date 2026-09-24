# opensesame-toolbar

A minimal operator helper on the Host/authority plane, binary
`opensesame-toolbar`. It checks the local daemon's health and status and
forwards two human approvals — a CLI device code and a claim completion —
through the daemon. It talks to the daemon only, never to the Host or Identity
API directly.

## Where it fits

- **Used by:** a person at the host. No workspace crate depends on it.
- **Builds on:** [`opensesame-host-core`](../../crates/host-core)
  (`daemon::base_url_is_local`) and [`apps/daemon`](../daemon)'s
  `/health` and `/v1/toolbar/*` routes.
- The daemon URL must be loopback, checked before any operator header is
  attached: the operator token stays on this machine.

## Surface

Global flags: `--daemon` (env `OPENSESAME_DAEMON_URL`, default
`http://127.0.0.1:18790`) and `--operator-token` (env
`OPENSESAME_OPERATOR_TOKEN`; every route but `/health` is operator-gated).

| Subcommand | Daemon route | Flags |
|---|---|---|
| `health` | `GET /health` | — |
| `status` | `GET /v1/toolbar/status` | — |
| `approve-device` | `POST /v1/toolbar/approve_device` | `--user-code`, `--principal` (default `user:demo`) |
| `approve-claim` | `POST /v1/toolbar/approve_claim` | `--claim-id`, `--claim-token` (env `OPENSESAME_CLAIM_TOKEN`, required), `--access-token` (env `OPENSESAME_ACCESS_TOKEN`) |

Prefer the environment variables for tokens so they stay out of shell history
and `ps`.

## Develop

```bash
cargo +1.88.0 test -p opensesame-toolbar
cargo +1.88.0 run -p opensesame-toolbar -- --help
cargo +1.88.0 run -p opensesame-toolbar -- health
```

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client topology
- [Architecture: device auth](../../docs/architecture/device-auth.md), [claims](../../docs/architecture/claims.md)
