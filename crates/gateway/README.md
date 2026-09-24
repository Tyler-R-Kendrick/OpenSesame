# opensesame-gateway

The Host API on `:8787`, served by `opensesame host run`, the centre of the
Host/authority plane. It runs the ConnectionRef → authorize → invoke → receipt
path, and hosts connections, tasks and intents, the sync blob store,
certificates and their issuers, event-driven backups, lifecycle and security
hooks, shared sessions, relayed execution, the operator transport routes and
signed provider callbacks (`POST /webhooks/{connection}/{route}`, mounted when
`OPENSESAME_CALLBACK_MASTER_KEY` is set; `src/callback_ingress`).
Agent-facing routes deal in `ConnectionRef` and intents, never raw secrets.

## Where it fits

- **Used by:** [`apps/cli`](../../apps/cli), [`crates/daemon`](../daemon) (proxy, mint
  passthrough), [`apps/mcp-host`](../../apps/mcp-host), [`apps/mcp-client`](../../apps/mcp-client),
  and [`apps/browser-extension`](../../apps/browser-extension) over HTTP; [`tests/mtls-interop`](../../tests/mtls-interop) runs `opensesame host run` as a process.
  The library exports `run`, `Args` and `cert_issuers`; nothing else is public.
- **Builds on:** [`opensesame-host-core`](../../crates/host-core),
  [`opensesame-storage`](../../crates/storage) (SQLite),
  [`opensesame-connection-broker`](../../crates/connection-broker),
  [`opensesame-connector-host`](../../crates/connector-host),
  [`opensesame-task-bus`](../../crates/task-bus),
  [`opensesame-lifecycle`](../../crates/lifecycle),
  [`opensesame-security-events`](../../crates/security-events),
  [`opensesame-transport-security`](../../crates/transport-security) and the
  rest of `Cargo.toml`.
- No `getSecret()`: agent-facing APIs use ConnectionRef + Intent
  ([ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md)). Deadlines
  publish on the `lifecycle.*` feed ([ADR 0074](../../docs/adr/0074-expiry-lifecycle-hooks.md));
  security facts go through `security::dispatch` ([ADR 0080](../../docs/adr/0080-security-event-hooks.md)).

## Surface

Flags (each also an env var): `--listen` (`OPENSESAME_LISTEN`, default
`127.0.0.1:8787`), `--resource` (`OPENSESAME_RESOURCE`), `--issuer`
(`OPENSESAME_ISSUER`), `--database-url` (`OPENSESAME_DB`), `--task-database-url`
(`OPENSESAME_TASK_DB`). Feature `wasm-connectors` (default off) enables the
community Wasm connector runtime. Contract: [`spec/openapi/host-api.yaml`](../../spec/openapi/host-api.yaml).

| Route group | Prefixes (bare names are under `/api/v1/`) |
|---|---|
| Health, discovery | `/health/*`, `/api/v1/health`, `/auth.md`, `/api/v1/whoami` |
| Connections | `/api/v1/connections`, `providers`, `custom-providers`, `configs`, `delegations`, `attachments` |
| Authority | `/api/v1/tasks`, `intents`, `receipts`, `agent*`, `host-authorizations`, `ceremonies`, `/experimental/aauth/*` |
| Sessions, pairing | `/api/v1/session`, `sessions`, `shared-sessions`, `browser-pairings`, `browser-clients`, `device`, `/pair` |
| Sync, backup | `/api/v1/sync`, `sync-targets`, `backup`, `changelog` |
| Certificates | `/api/v1/certs`, `/api/v1/certmgr/*`, `/.well-known/est/*` |
| Lifecycle, security | `/api/v1/lifecycle`, `rotations`, `security`, `a2h` |
| Relay, task bus | `/api/v1/relay`, `/api/v1/nats` |
| Operator | `/api/v1/operator/*` (incl. `operator/transport/*`), `/api/v1/admin` |
| KV v2 facade | `/v1/sys`, `/v1/{mount}`, only with `OPENSESAME_KV_FACADE=true` |

Source areas under `src/`: `routes/` (one module per group), `middleware/`
(caller resolution, agent and browser grants), `transport/` and
`transport_lifecycle/` (mTLS admission, bindings, certificate lifecycle),
`cert_issuers/` (ACME, Cloudflare), `lifecycle/`, `security/`, `breach/`,
`backup*.rs`, `session_channel*`, `task_engine.rs`, `sync_actor.rs`, `config.rs`.

## Develop

```bash
cargo +1.88.0 test -p opensesame-gateway
cargo +1.88.0 run -p opensesame-cli -- host run --listen 127.0.0.1:8787
pnpm test:live-stack    # live OpenFGA / OpenBao / gateway
pnpm test:mtls          # transport-security contract suites
```

`tests/startup_security.rs` checks that a configuration refusal comes before
SQLite or a listener starts. Response shapes are `insta` snapshots in
`src/routes/snapshots/`. A new route needs a
[`capability-registry`](../../packages/capability-registry) entry
([ADR 0065](../../docs/adr/0065-agent-surface-parity.md)).

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md), [ADR 0032](../../docs/adr/0032-connection-broker-service-integrations.md), [ADR 0039](../../docs/adr/0039-event-driven-github-backup.md), [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md), [ADR 0075](../../docs/adr/0075-host-certificate-key-custody.md), [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)
- [Architecture: connection broker](../../docs/architecture/connection-broker.md), [transport topology](../../docs/architecture/transport-topology.md)
- [Operators: health and operations](../../docs/operators/health-and-operations.md), [mTLS](../../docs/operators/mtls.md), [security alerting](../../docs/operators/security-alerting.md)
