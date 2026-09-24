# opensesame-protocol-aauth

An experimental adapter for the AAuth draft-10 protocol on the Host / authority
plane. It maps AAuth `Person`, `Agent` and `Mission` objects onto OpenSesame
domain identities losslessly, so they round-trip, and derives a governance
context from a mission's digest. It has no HTTP endpoints and claims no protocol
conformance.

## Where it fits

- **Used by:** [`apps/gateway`](../../apps/gateway) (`src/routes/aauth.rs`,
  under `/experimental/aauth/v1/*`) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`aauth_parse`). Both enable the
  `experimental-aauth` feature.
- **Builds on:** [`opensesame-domain`](../domain) (`PrincipalId`, `ActorId`,
  `ActorInstanceId`, `digest_sha256`).
- Disabled twice: the adapter compiles only with `experimental-aauth`, and the
  gateway routes answer only when `OPENSESAME_AAUTH_EXPERIMENTAL=true`.
- One person maps to one principal (`assert_one_person`); a second person is an
  error, not a merge.

## Surface

| Cargo feature | Effect |
|---|---|
| `experimental-aauth` (off by default) | Compiles and exports `adapter` |

With the feature on:

| Item | Role |
|---|---|
| `Person`, `Agent`, `Mission` | AAuth draft-10 input shapes |
| `map_person` / `unmap_person`, `map_agent` / `unmap_agent` | Lossless mappings that keep source ids |
| `mission_to_governance_context`, `GovernanceContext` | Mission bytes to a digest-keyed context |
| `assert_one_person`, `ProtocolTokenRef` | Single-principal invariant; token identity as `(issuer, jti)` |
| `AAuthError` (always compiled) | `MultiplePersons`, `Domain` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-protocol-aauth --features experimental-aauth
pnpm test:task-access   # runs the line above among the task-authority suites
```

Without the feature only a pact test runs; it checks that `lib.rs` still gates
the adapter.

## Related

- [ADR 0025](../../docs/adr/0025-aauth-experimental.md) — AAuth as experimental
- [ADR 0029](../../docs/adr/0029-protocol-token-identity.md) — protocol token identity
- [`docs/reference/protocol-profiles.md`](../../docs/reference/protocol-profiles.md)
