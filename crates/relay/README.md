# opensesame-relay

Fail-closed admission rules for relayed execution on the Host / authority
plane. When an upstream credential cannot be attenuated, a delegation may run
in `relay` mode: the credential stays with its holder and the delegate's
request travels to the holder's runtime, which executes it. This crate is the
one answer to "may this relayed request run?", written as a pure function so
the gateway and the holder cannot disagree.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (`src/routes/relay.rs`,
  which runs `admit` at both submission and result) and
  [`opensesame-connection-broker`](../connection-broker) (`ExecutionMode` on a
  delegation).
- **Builds on:** [`opensesame-domain`](../domain) (`AvailabilityClass`,
  `OfflineUse`).
- Every rule refuses rather than defers. An offline holder ends the request; it
  is never queued. What runs must match the approved digest in full; a prefix
  match would let a request grow after consent. Materialization is denied on
  every relay path (ADR 0005 level 3).

## Surface

| Item | Role |
|---|---|
| `admit(&RelayAdmission) -> Result<(), RelayRefusal>` | The decision |
| `RelayAdmission` | Mode, holder liveness, availability class, offline stance, approved and executing digests, approval flags, materialize flag |
| `ExecutionMode` | `Broker` (the gateway holds the sealed credential, ADR 0044) or `Relay` |
| `HolderLiveness` | `Online`, `Offline` |
| `RelayRefusal` | `NotRelayMode`, `MaterializeDenied`, `HolderOffline`, `ApprovalRequired`, `DigestMismatch` — checked in that order |

## Develop

```bash
cargo +1.88.0 test -p opensesame-relay
pnpm test:mutation:rust   # src/lib.rs is in the mutation scope
```

The liveness rule is stated outright rather than derived from `class` and
`offline_use`; a surviving mutant showed the derivation did no work. Keep new
rules independently sufficient to refuse.

## Related

- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — relayed execution and the authorization inbox
- [ADR 0044](../../docs/adr/0044-claimable-connection-delegation.md) — claimable connection delegation
- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — authority handle and ConnectionRef
