# opensesame-broker

The invocation broker for the Host / authority plane: the step between an
authorized intent and a signed receipt. `Broker` checks that the intent is fresh
and the grant active, that both belong to the same organization, that policy
and quorum allow it and that the idempotency key is new — then runs the
connector and signs an `InvocationReceipt`. A repeated idempotency key returns
the receipt already stored, or fails as a conflict while the first attempt has
none, instead of running twice.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) (bootstrap, app state, and
  the intents, intents-queue, tasks, receipts and KV-facade routes) and
  [`opensesame-host-core`](../host-core) (re-exported as `host_core::broker`).
- **Builds on:** [`opensesame-authz`](../authz) (`PolicyEngine`, AuthZEN
  request), [`opensesame-connector-host`](../connector-host) (`HostRuntime`,
  `InvokeRequest`), [`opensesame-storage`](../storage) (`Db`, idempotency
  lookups), [`opensesame-audit`](../audit) (`ReceiptSigner`),
  [`opensesame-task-access`](../task-access) (frozen invokes) and
  [`opensesame-domain`](../domain).
- A raw `parent_grant_id` is not eligibility: delegated exercise needs a
  verified `ValidatedGrantChain` in `lineage`.
- The frozen path never accepts a second, mutable parameter blob: it persists
  the digest, authorizes that digest, and executes the canonical arguments from
  the same intent.

## Surface

| Item | What it is |
|---|---|
| `Broker { db, policy, host, signer }` | The broker's dependencies |
| `InvokeInput` | `intent`, `grant`, `subject`, `connection_policy_id`, `parameters`, `lineage` |
| `Broker::invoke` | Runs the invocation through the synchronous `HostRuntime` |
| `Broker::invoke_with` | Same checks, then an authority-owned async executor — the path for credentialed network connectors |
| `Broker::invoke_frozen` | Authority-bearing invoke over `FrozenIntentV2` bytes with a `TaskAccessEngine` |
| `FrozenInvokeInput`, `assert_grant_covers_frozen_intent` | Every scoped grant field must cover the frozen intent (ADR 0027) |

| Cargo feature | Effect |
|---|---|
| `concurrency-test` | Pulls in `shuttle` and enables the `shuttle_idempotency` test |

## Develop

```bash
cargo +1.88.0 test -p opensesame-broker
cargo +1.88.0 test -p opensesame-broker --features concurrency-test --test shuttle_idempotency
pnpm audit:shuttle   # runs the shuttle suite above with the other crates'
```

`tests/adversarial_broker.rs` covers idempotency, organization isolation,
expiry and quorum. `tests/shuttle_idempotency.rs` explores schedules against
the storage crate's organization-scoped idempotency constraint.

## Related

- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) —
  ConnectionRef + Intent
- [ADR 0027](../../docs/adr/0027-one-effective-authority.md) — one effective
  authority
- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) —
  broker versus relay execution
