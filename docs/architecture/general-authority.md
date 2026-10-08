# General authority

**Partly implemented.** This page keeps the invariants in one place that is
not a work item, and says what "general authority" means. Decisions and
rationale are in
[ADR 0120](../adr/0120-generalized-hierarchical-authority.md) (status:
Accepted, implementation in progress). Per-item implementation status is in
[`docs/implementation/general-authority/`](../implementation/general-authority/completion-matrix.json);
the code that exists is listed under "Where the pieces live" below.

## The idea

Authority has been expressed once per resource family. A project has
memberships with `owner | admin | member` (ADR 0038); a connector binding is a
local share grant of kind `connection` (ADR 0115); a row-level vault grant is
an OpenFGA tuple on `vault_item`; a connection's users are a relation on
`connection`. Each is correct in isolation, and none of them can answer "this
authority, but narrower, for this agent, until Friday" in a way the other
surfaces understand.

ADR 0120 extends the `Grant` lineage that already exists in
`crates/domain/src/grant.rs` rather than adding a second lease store.

General authority is one record that names a subject, a resource scope, a set
of verbs, a parent it derives from, and a deadline — and that can only ever
narrow what its parent already allowed.

## The invariants it has to satisfy

Authoritative list, with owners and status:
[`contract-registry.json`](../implementation/general-authority/contract-registry.json).
Summarised:

| Invariant | In one line |
|---|---|
| `INV-GA-01` | A derived authority never widens its parent. |
| `INV-GA-02` | An authority is a handle, never a secret value (ADR 0005). |
| `INV-GA-03` | The OpenFGA model delta is additive; no passing check starts failing. |
| `INV-GA-04` | One parent per authority; the hierarchy roots at a project (ADR 0038). |
| `INV-GA-05` | Deadlines publish on the `lifecycle.*` feed, never a private due-check (ADR 0074). |
| `INV-GA-06` | Delegation chains terminate: bounded depth, cycles refused. |
| `INV-GA-07` | Revoking a parent revokes its descendants on the next read. |
| `INV-GA-08` | Grant and AccessLease are one record under two possible labels. |
| `INV-GA-09` | A sensitive authority change is digest-bound and spent once (ADR 0084/0086). |
| `INV-GA-10` | The client plane keeps one share ledger (ADR 0115). |
| `INV-GA-11` | Guest and anonymous access are untouched. |
| `INV-GA-12` | Every new capability is registered or ADR-excluded (ADR 0065). |

## What it deliberately is not

- **Not a second authority model.** A cross-device question stays an
  `Interaction`, and an approval counts only when the proof's `boundDigest`
  equals the interaction's `requestDigest` (ADR 0086).
- **Not a secret-bearing object.** No authority record carries a value and
  none implies a `getSecret()` affordance (ADR 0005).
- **Not a rewrite of `model.fga`.** See
  [`compatibility-map.md`](../implementation/general-authority/compatibility-map.md).
- **Not a rewrite of ADR 0038.** Its gaps are noted by reference in ADR 0120;
  the accepted text stands as written.
- **Not a BFF merge.** Identity and Host APIs stay separate (ADR 0017), which
  means authority has a representation on each side and one shared contract,
  not one service.

## Where the pieces live

| Plane | Home |
|---|---|
| Domain | `packages/os-domain` (`authority-grant.ts`, `authority-invariants.ts`, `authority-templates/`), mirroring `crates/domain/src/grant.rs` |
| Policy | `spec/openfga/model.fga` (for example `access_domain`, `cohort`), `packages/policy` (`authority-tuples.ts`, `authority-tuple-backfill.ts`) |
| Host | `crates/domain/src/grant.rs`, `crates/storage/src/authority.rs` (migration `0034_general_authority.sql`), `crates/gateway/src/routes/authority_grants.rs`, `crates/lifecycle/src/authority_grant_expiry.rs` |
| Identity | `packages/database/src/schema/authority.ts` (membership provenance and projection rows only; grants live in the Host store), `packages/control-plane/src/services/project-membership-reconcile.ts` |
| Client | `packages/app-core/src/lib/local-share-grants.ts` and the Access surfaces |
| Parity | `packages/capability-registry/src/general-authority.ts` plus the per-surface sweeps |

## Related

- [ADR 0120](../adr/0120-generalized-hierarchical-authority.md) — Accepted, implementation in progress
- [ADR 0038](../adr/0038-project-hierarchy-sharing.md) — projects as the top-level container
- [ADR 0005](../adr/0005-authority-handle-connectionref.md), [ADR 0017](../adr/0017-host-client-product-topology.md), [ADR 0065](../adr/0065-agent-surface-parity.md), [ADR 0074](../adr/0074-expiry-lifecycle-hooks.md), [ADR 0084](../adr/0084-external-authorization-notifications.md), [ADR 0086](../adr/0086-wallet-native-interaction-layer.md), [ADR 0115](../adr/0115-front-door-and-connector-directory.md)
- [`connection-broker.md`](connection-broker.md), [`identity-plane.md`](identity-plane.md), [`host-client-topology.md`](host-client-topology.md)
