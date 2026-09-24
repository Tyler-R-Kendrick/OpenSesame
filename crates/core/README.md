# opensesame-core

The core SDK facade: the shared intermediate representation both planes build
on, with no I/O. It re-exports all of [`opensesame-domain`](../domain) —
principals, grants, intents, receipts and `AuthorityHandle` — under one name
and pins the WIT package it corresponds to. New host and client dependents
should take this facade rather than the domain crate directly (ADR 0017).

## Where it fits

- **Used by:** [`opensesame-host-core`](../host-core) and
  [`opensesame-client-core`](../client-core), each of which re-exports it as
  `core`.
- **Builds on:** [`opensesame-domain`](../domain), re-exported whole
  (`pub use opensesame_domain::*`).
- A connection `AuthorityHandle` is never of the `Secret` kind; the crate's
  tests pin that.

## Surface

| Item | What it is |
|---|---|
| everything in `opensesame_domain` | See [`crates/domain`](../domain) |
| `wit_contract::PACKAGE` | `opensesame:core@1.0.0` — the [`spec/wit/core/world.wit`](../../spec/wit/core/world.wit) world |

## Develop

```bash
cargo +1.88.0 test -p opensesame-core
```

## Related

- [ADR 0017](../../docs/adr/0017-host-client-product-topology.md) — host/client
  topology and the SDK facades
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — the
  authority handle
