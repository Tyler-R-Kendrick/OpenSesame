# @opensesame/claims

The claim-session engine for the Identity plane. A claim transfers ownership
or delegation of agents, projects and resources to a principal; it is not
device authorization. `ClaimEngine` creates a claim (a bearer token and a user
code, both stored only as peppered digests), then moves it through present,
authenticate, review and complete, or deny, revoke and expire, with every
transition persisted by compare-and-swap on the session version.

## Where it fits

- **Used by:** [`apps/control-plane`](../../apps/control-plane) (the claim
  routes and a database-backed `ClaimStore` in `src/repos/claim-store.ts`) and
  [`apps/worker`](../../apps/worker) (expiry cleanup).
- **Builds on:** [`@opensesame/os-domain`](../os-domain), which owns the claim
  state machine, the manifest digest, token and user-code generation and
  verification.
- A `ClaimStore` must provide an atomic compare-and-swap on `version`.
  Completion is idempotent for the same completer and decision, and its CAS
  retries are bounded.

## Surface

| Export | What it does |
|---|---|
| `ClaimEngine({ pepper, store, clock? })` | `createClaim`, `presentClaim`, `authenticateClaim`, `reviewClaim`, `completeClaim`, `deny`, `revoke`, `expire`, `get`, `getItems` |
| `ClaimStore` | The persistence seam: `get`, `getItems`, `putItems`, `create`, `compareAndSwap` |
| `MemoryClaimStore` | An in-memory `ClaimStore` for tests and local use |
| `CreateClaimInput`, `CreateClaimResult`, `CompleteDecision`, `ClaimEngineOptions` | Types |

## Develop

```bash
pnpm --filter @opensesame/claims test
pnpm --filter @opensesame/claims typecheck
```

## Related

- [ADR 0009](../../docs/adr/0009-claims-vs-device-auth.md) — claims versus
  device authorization
- Device authorization: [`@opensesame/device-auth`](../device-auth)
