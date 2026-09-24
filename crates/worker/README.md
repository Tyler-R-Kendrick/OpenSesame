# opensesame-worker

The workload connector host on the Host/authority plane, served by
`opensesame worker run`. It exposes readiness and a provider listing; it
accepts no work and has no invocation endpoint.

## Where it fits

- **Run by:** [`apps/cli`](../../apps/cli) (`opensesame worker run`). The Host
  API probes its `mtls_required` listener as the `worker` hop
  (`OPENSESAME_WORKER_PROBE_ADDR`).
- **Builds on:** [`opensesame-connector-host`](../connector-host) (provider
  catalogue), [`opensesame-domain`](../domain),
  [`opensesame-transport-security`](../transport-security).
- The `mtls_required` profile reads no token at all, and refuses to start if
  its certificate material is missing; it never downgrades to
  `existing_local` ([ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)).

## Surface

`opensesame worker run`:

| Flag / variable | Meaning |
|---|---|
| `--id` | Worker id (default `worker-1`) |
| `--listen` / `OPENSESAME_WORKER_LISTEN` | Default `127.0.0.1:8790` |
| `--providers` / `OPENSESAME_WORKER_PROVIDERS` | Required, comma-separated provider ids this workload may host |
| `OPENSESAME_WORKER_TRANSPORT` | `existing_local` (loopback plus `OPENSESAME_WORKER_TOKEN` or `OPENSESAME_OPERATOR_TOKEN`) or `mtls_required` |
| `OPENSESAME_WORKER_TLS`, `OPENSESAME_WORKER_BINDINGS_FILE`, `OPENSESAME_WORKER_TLS_CLIENT_TRUST_PROFILE` | `mtls_required` material and service bindings |

Routes: `GET /health/live`, `GET /health/ready`, `GET /v1/providers`.

## Develop

```bash
cargo +1.88.0 test -p opensesame-worker
cargo +1.88.0 run -p opensesame-cli -- worker run --help
```

## Related

- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS
- [ADR 0138](../../docs/adr/0138-self-issued-identity-one-native-host.md) — one native binary
