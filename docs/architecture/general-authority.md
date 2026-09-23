# General authority

**Stub. Nothing described here is implemented.** This page exists so the
invariants have a home that is not a work item, and so a reader who finds the
term "general authority" in a branch or a work ID can find out what it is
supposed to mean. Decisions and rationale are in
[ADR 0120](../adr/0120-generalized-hierarchical-authority.md) (status:
Proposed). Implementation status is in
[`docs/implementation/general-authority/`](../implementation/general-authority/completion-matrix.json)
and every item there is unresolved.

## The idea

Today authority is expressed once per resource family. A project has
memberships with `owner | admin | member` (ADR 0038); a connector binding is a
local share grant of kind `connection` (ADR 0115); a row-level vault grant is
an OpenFGA tuple on `vault_item`; a connection's users are a relation on
`connection`. Each is correct in isolation, and none of them can answer "this
authority, but narrower, for this agent, until Friday" in a way the other
surfaces understand.

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

## What is deliberately not being proposed

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

## Where the pieces would live

Prospective, unbuilt, and listed only so two swarms do not pick the same file:

| Plane | Prospective home |
|---|---|
| Domain | `packages/os-domain` — the record, the narrowing algebra, the invariant assertions |
| Policy | `policy/openfga/model.fga` (additive delta), `packages/policy` |
| Host | `crates/host-core` (evaluation), `crates/storage` (a new module, per ADR 0093), `crates/lifecycle` (expiry) |
| Identity | `apps/control-plane`, `packages/database`, `packages/audit` |
| Client | `packages/app-core/src/lib/local-share-grants.ts` and the Access surfaces |
| Parity | `packages/capability-registry` plus the per-surface sweeps |

## Related

- [ADR 0120](../adr/0120-generalized-hierarchical-authority.md) — Proposed
- [ADR 0038](../adr/0038-project-hierarchy-sharing.md) — projects as the top-level container
- [ADR 0005](../adr/0005-authority-handle-connectionref.md), [ADR 0017](../adr/0017-host-client-product-topology.md), [ADR 0065](../adr/0065-agent-surface-parity.md), [ADR 0074](../adr/0074-expiry-lifecycle-hooks.md), [ADR 0084](../adr/0084-external-authorization-notifications.md), [ADR 0086](../adr/0086-wallet-native-interaction-layer.md), [ADR 0115](../adr/0115-front-door-and-connector-directory.md)
- [`connection-broker.md`](connection-broker.md), [`identity-plane.md`](identity-plane.md), [`host-client-topology.md`](host-client-topology.md)
