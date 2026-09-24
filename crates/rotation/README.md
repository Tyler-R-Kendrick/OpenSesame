# opensesame-rotation

The credential rotation state machine for the Host / authority plane: fifteen
states and the only edges allowed between them. A new credential is generated,
installed, verified and activated, dependents are updated and observed, and
only then is the previous credential revoked and the revocation verified. Every
step from install through observation can roll back, and an uncertain
provider outcome goes to `ReconciliationRequired` instead of being retried.

## Where it fits

- **Used by:** [`opensesame-connection-broker`](../connection-broker)
  (`src/rotation.rs`) and the fuzz crate
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`rotation_fsm`).
- **Builds on:** nothing from the workspace in its source; the state machine
  uses only `serde` and `thiserror`.
- Verify before revoke is structural: there is no edge to `PreviousRevoked`
  before `Observing`, and `Completed` is a sink. Web-login rotation
  ([`opensesame-rotation-web`](../rotation-web)) adds no states to it.

## Surface

| Item | Role |
|---|---|
| `RotationState` | `Scheduled` → `Discovering` → `CandidateGenerated` → `CandidateInstalled` → `CandidateVerified` → `CandidateActivated` → `DependentsUpdated` → `Observing` → `PreviousRevoked` → `RevocationVerified` → `Completed`; plus `RollbackStarted`, `RollbackCompleted`, `RollbackFailed`, `ReconciliationRequired` |
| `RotationState::can_transition`, `transition` | Check or take one edge |
| `RotationError` | `InvalidTransition`, `Indeterminate` |

| Cargo feature | Effect |
|---|---|
| `concurrency-test` | Pulls in `shuttle` and enables the `shuttle_rotation` test |

## Develop

```bash
cargo +1.88.0 test -p opensesame-rotation
pnpm audit:shuttle   # shared state never takes an illegal edge
pnpm audit:kani      # bounded proofs in the `kani_proofs` module
```

A new edge must keep the Kani proofs (`completed_is_a_sink`,
`cannot_revoke_before_observe`, `transition_matches_can_transition`) and the
unit tests passing.

## Related

- [ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) — autonomous web-login rotation
- [ADR 0036](../../docs/adr/0036-coverage-guided-fuzz-and-bounded-proofs.md) — fuzzing and bounded proofs
- [`docs/architecture/web-login-rotation.md`](../../docs/architecture/web-login-rotation.md)
