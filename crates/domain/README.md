# opensesame-domain

The canonical domain model for the Host / authority plane: identifiers,
resources, invariants and errors, with no I/O. Principals, organizations,
grants, intents, invocations, receipts, connections, tasks, sessions and
transport contracts are defined here once, and every other crate takes them
from here. Stable principal identity is independent of keys, hostnames and
provider ids.

## Where it fits

- **Used by:** nearly every crate in [`crates/`](..) — among them
  [`authz`](../authz), [`broker`](../broker), [`storage`](../storage),
  [`connection-broker`](../connection-broker), [`audit`](../audit),
  [`transport-security`](../transport-security) — plus
  [`apps/gateway`](../../apps/gateway), [`apps/worker`](../../apps/worker),
  [`apps/cli`](../../apps/cli), [`tests/mtls-interop`](../../tests/mtls-interop)
  and the fuzz harness in [`tests/fuzz/cargo`](../../tests/fuzz/cargo). New
  dependents should prefer the [`opensesame-core`](../core) facade, which
  re-exports this crate whole.
- **Builds on:** no workspace crates — `chrono`, `serde`, `serde_json`,
  `sha2`, `blake3`, `thiserror`, `uuid`, `url`.
- Authority narrows. A delegated grant must attenuate its parent on every
  dimension (`grant_attenuation`), and a raw `parent_grant_id` is data, not
  proof — only an in-process `ValidatedGrantChain` establishes lineage.
- An authority handle is a reference, not a capability (`authority`).
- A `VerifiedPeer` is never deserialized from a header or body; service
  bindings are exact and default-deny (`transport`, ADR 0132). The TypeScript
  mirror lives in [`packages/os-domain`](../../packages/os-domain).

## Surface

Most modules are glob re-exported at the root. `budget` is not: call sites say
`budget::` so names like `Limit` and `Meter` do not collide.

| Area | Modules |
|---|---|
| Identity and tenancy | `ids`, `organization`, `access_domain` (realm-bound forest of authority containers), `provider` |
| Authority and grants | `authority`, `authority_context`, `grant`, `grant_attenuation`, `grant_lineage`, `grant_budgets`, `delegation_chain`, `validated_grant_chain`, `capability`, `permission`, `permission_entry` (superseded by `permission`) |
| Requests and results | `intent`, `frozen_intent`, `invocation`, `receipt`, `canonical` (canonical JSON digests), `error` |
| Requirements and proof | `authorization_requirement`, `authentication_policy`, `protected_resource`, `protocol_profile`, `proof`, `verification_evidence`, `mediation` |
| Tasks and budgets | `task` (trust-ratchet transitions), `budget` (reservation, settlement, inheritance) |
| Groups and sessions | `cohort*` (who may ask, never who holds), `shared_session`, `session_invite`, `session_admission`, `session_coordination`, `claim` |
| Connections and transport | `connection`, `availability`, `transport` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-domain
cargo +1.88.0 test -p opensesame-domain --features concurrency-test --test shuttle_authority
pnpm audit:kani      # bounded proofs over this crate and opensesame-rotation
pnpm audit:miri      # lib tests under Miri
pnpm audit:shuttle   # includes shuttle_authority
```

Adversarial suites (`*_adversarial.rs`, `honest_attacks.rs`) and the fixture
scenarios (`fix_*.rs`) are test-only modules beside the code they attack. `tests/budget_properties.rs`
uses `proptest`. The crate allows `cfg(kani)` for the Kani harnesses.

## Related

- [ADR 0005](../../docs/adr/0005-authority-handle-connectionref.md) — authority
  handle and `ConnectionRef`
- [ADR 0044](../../docs/adr/0044-claimable-connection-delegation.md) — grant
  attenuation and delegation chains
- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) —
  generalized hierarchical authority
- [ADR 0132](../../docs/adr/0132-optional-mtls-and-workload-identity.md) —
  transport contracts
