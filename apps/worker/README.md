# @opensesame/worker

The Identity-plane background loop: it drains the outbox onto the TaskBus,
fans out webhooks and notifications, and prunes the issuer's expired rows.
The Host plane's workload connector host is a different thing, served by
`opensesame worker run` from [`crates/worker`](../../crates/worker).

## Where it fits

- **Used by:** the root `pnpm dev` starts it. Nothing in the workspace
  imports the package.
- **Builds on:** [`@opensesame/database`](../../packages/database)
  (repositories, Drizzle, the OIDC store), [`@opensesame/webhooks`](../../packages/webhooks),
  [`@opensesame/claims`](../../packages/claims),
  [`@opensesame/observability`](../../packages/observability), and the `nats`
  client for JetStream.
- It refuses to start without `DATABASE_URL`. Claim,
  session and project expiry run in the control plane's process, not here.
- With `OPENSESAME_TASKBUS=nats` (or `NATS_URL` set) it publishes to
  `opensesame.events.{type}` on JetStream and never falls back to core NATS.
  The Host owns the `OPENSESAME_EVENTS` stream.

## Surface

`src/index.ts`: `runCleanupTick`, `startCleanupLoop`;
`routeNotification`, `deliverNotifications`, `retractNotifications`;
`consumeRotationEvents` and the `credential.rotation.*` event names;
`MemoryTaskBus`, `NatsCoreTaskBus`, `createTaskBusFromEnv`. Environment:
`DATABASE_URL` (required), `OPENSESAME_WORKER_INTERVAL_MS` (default `5000`),
`OPENSESAME_TASKBUS`, `NATS_URL`.

## Develop

```bash
pnpm --filter @opensesame/worker dev          # tsx watch src/main.ts
pnpm --filter @opensesame/worker start
pnpm --filter @opensesame/worker typecheck
pnpm --filter @opensesame/worker test         # vitest, src/**/*.test.ts
pnpm test:nats-dogfood                        # real nats-server
```

## Related

- [ADR 0042](../../docs/adr/0042-nats-taskbus-auth-callout-and-xkeys.md) — NATS TaskBus
- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — authorization-request inbox webhooks
- [ADR 0084](../../docs/adr/0084-external-authorization-notifications.md) — external notifications
- [Architecture: task bus over NATS](../../docs/architecture/task-bus-nats.md), [operators: notification channels](../../docs/operators/notification-channels.md)
