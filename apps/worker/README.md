# @opensesame/worker

The background worker. This directory holds two programs. The TypeScript one
(`@opensesame/worker`) is the Identity-plane cleanup loop: it drains the
outbox onto the TaskBus, fans out webhooks and notifications, and prunes the
issuer's expired rows. The Rust one (`opensesame-worker`) is a workload
connector host on the Host/authority plane that exposes readiness and a
provider listing; it accepts no work and has no invocation endpoint.

## Where it fits

- **Used by:** the root `pnpm dev` starts the TypeScript worker. Nothing in
  the workspace imports the package or depends on the crate.
- **Builds on (TypeScript):** [`@opensesame/database`](../../packages/database)
  (repositories, Drizzle, the OIDC store), [`@opensesame/webhooks`](../../packages/webhooks),
  [`@opensesame/claims`](../../packages/claims),
  [`@opensesame/observability`](../../packages/observability), and the `nats`
  client for JetStream.
- **Builds on (Rust):** [`opensesame-connector-host`](../../crates/connector-host)
  (provider catalogue), [`opensesame-domain`](../../crates/domain),
  [`opensesame-transport-security`](../../crates/transport-security).
- The TypeScript worker refuses to start without `DATABASE_URL`. Claim,
  session and project expiry run in the control plane's process, not here.
- With `OPENSESAME_TASKBUS=nats` (or `NATS_URL` set) it publishes to
  `opensesame.events.{type}` on JetStream and never falls back to core NATS.
  The Host owns the `OPENSESAME_EVENTS` stream.
- The Rust worker's `mtls_required` profile reads no token at all, and
  refuses to start if its certificate material is missing; it never downgrades
  to `existing_local` ([ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md)).

## Surface

**TypeScript** (`src/index.ts`): `runCleanupTick`, `startCleanupLoop`;
`routeNotification`, `deliverNotifications`, `retractNotifications`;
`consumeRotationEvents` and the `credential.rotation.*` event names;
`MemoryTaskBus`, `NatsCoreTaskBus`, `createTaskBusFromEnv`. Environment:
`DATABASE_URL` (required), `OPENSESAME_WORKER_INTERVAL_MS` (default `5000`),
`OPENSESAME_TASKBUS`, `NATS_URL`.

**Rust** binary `opensesame-worker`:

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
pnpm --filter @opensesame/worker dev          # tsx watch src/main.ts
pnpm --filter @opensesame/worker start
pnpm --filter @opensesame/worker typecheck
pnpm --filter @opensesame/worker test         # vitest, src/**/*.test.ts
cargo +1.88.0 test -p opensesame-worker
cargo +1.88.0 run -p opensesame-worker -- --help
pnpm test:nats-dogfood                        # real nats-server
```

## Related

- [ADR 0042](../../docs/adr/0042-nats-taskbus-auth-callout-and-xkeys.md) — NATS TaskBus
- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — authorization-request inbox webhooks
- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) — external notifications
- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) — optional mTLS
- [Architecture: task bus over NATS](../../docs/architecture/task-bus-nats.md), [operators: notification channels](../../docs/operators/notification-channels.md)
