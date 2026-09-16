# ADR 0120 — Authority is one hierarchical record that can only narrow, generalizing Grant across both planes

Status: Accepted (implementation in progress)
Date: 2026-09-15
References:
ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0017 ([host/client product topology](0017-host-client-product-topology.md)),
ADR 0038 ([projects, memberships and sharing](0038-project-hierarchy-sharing.md)),
ADR 0065 ([agent surface parity](0065-agent-surface-parity.md)),
ADR 0074 ([expiry lifecycle hooks](0074-expiry-lifecycle-hooks.md)),
ADR 0079 ([shared sessions and scoped grants](0079-shared-sessions-and-scoped-grants.md)),
ADR 0084 ([external authorization notifications](0084-external-authorization-notifications.md)),
ADR 0086 ([one interaction primitive](0086-wallet-native-interaction-layer.md)),
ADR 0093 ([structural quality gates](0093-structural-quality-gates.md)),
ADR 0115 ([front door and connector directory](0115-front-door-and-connector-directory.md)),
[general authority](../architecture/general-authority.md),
[implementation status](../implementation/general-authority/completion-matrix.json)

**Implementation is in progress on a dirty tree at baseline `4358f7fe`.**
Canonical authority remains the existing `Grant` lineage (`crates/domain`); this
ADR forbids a second AccessLease engine. Track verified vs incomplete work in
[`docs/implementation/general-authority/completion-matrix.json`](../implementation/general-authority/completion-matrix.json)
and the authority-fabric report under `docs/evidence/general-authority/`.
As of 2026-09-16: `pnpm test:authority-fabric` with OpenFGA reports **48 pass / 0 blocked / 3 unsupported** (GA-V-29 shuttle, GA-V-33b live OpenBao, GA-V-34 naming). FIX-FAMILY..GENERALITY (GA-V-35..50), AccessDomain Host routes, and `AuthorityGrant` lifecycle feed are command-backed. Remaining DoD: full AT-* live/provider rows, Identity enrollment gaps, receipts, Discord live opt-in, OpenBao binary for live stack.


As of 2026-09-15 coordinator progress (command-backed, not a full product gate):
complete attenuation dimensions + `ValidatedGrantChain`; PolicyEngine no longer
trusts raw `parent_grant_id` or client-authored assurance; correlated
`PermissionEntry`; realm-bound `AccessDomain` forest; budget ledger conservation;
`opensesame-enforcement` descriptors; DNS Blocky adapter crate; Wasmtime sandbox
profile crate; declarative audience templates in
`packages/os-domain/src/authority-templates/` (family / contractor / raid plus
guest / classroom / incident / ci / agent-workcell / research-workshop) with an
Access › Sessions `LocalAuthorityTemplates` panel that shows vocabulary,
defaults, and an honest support matrix (Blocky / OS app blocking are not
advertised as in force). Persistence, OpenFGA additive model wiring, template →
domain minting journeys, and remote-enforcement wiring remain open.

## Context

Authority in OpenSesame is expressed once per resource family, and each
expression is reasonable on its own:

| Where | Shape | Grain |
|---|---|---|
| Identity plane | `ProjectMembership` — `owner \| admin \| member` (ADR 0038) | A whole project |
| Client plane | `LocalShare` / `ShareKind` in `apps/pages/src/lib/local-share-grants.ts`, including `connection` bindings (ADR 0115) | A vault or a connection |
| Policy | `policy/openfga/model.fga` relations hanging off `project`; `vault_item` reader/writer inheriting from `vault_collection` | A collection or one row |
| Connections | `connection.user`, `connector_operation.executor` | A connection or an operation |

The inspected baseline already contained a general `Grant` / `GrantConstraints`
model in `crates/domain/src/grant.rs` (issuer/beneficiary, bindings, budgets,
parentage, attenuation helpers) plus AuthZEN decision paths in `crates/authz`.
This programme **extends that lineage**; it does not invent a parallel lease
store. Earlier bootstrap docs that said "there is no Grant type" were wrong
about the Host domain crate and have been corrected here.

Four things this cannot express, and which are being asked for:

1. **Narrowing.** "What I have, but less of it, for this agent." Every family
   above can add a subject at its own grain; none can derive a smaller
   authority from a larger one and know that it is smaller.
2. **Delegation with an audit-legible parent.** Who conferred this, from what,
   is inferred rather than stored.
3. **Uniform deadlines.** ADR 0074 gave every deadline one feed, and ADR 0079
   assumed "every grant carries a TTL". Membership has no TTL field, so there
   is nothing for the scanner to see.
4. **Revocation that reaches downstream.** Removing a member does not, by
   construction, invalidate anything derived from that membership, because
   nothing records that it was derived.

### ADR 0038's gaps, noted by reference only

ADR 0038 is **Accepted and stands as written.** This ADR does not edit it, and
no one should rewrite its text to match this proposal. For the record, and by
reference:

- ADR 0038 § 1 makes projects the top-level container. This ADR keeps that and
  roots the hierarchy there (`INV-GA-04`); it does not introduce a new top.
- ADR 0038 § 5 defines `project_memberships` with owner/admin/member and CRUD.
  It defines no expiry, no parent edge, and no sub-project grain. Those
  absences are the gap this ADR addresses — they are not defects in 0038,
  which was scoped to project hierarchy and sharing.
- ADR 0038 § 7 gates `project.create` and audits membership mutations. A
  generalized authority needs the same treatment for derived records; this ADR
  extends that pattern rather than replacing it.

Where this ADR's decisions and ADR 0038's text differ in scope, ADR 0038
remains authoritative for projects and memberships until this one is Accepted
and its work lands. Superseding language, if any, belongs in a later revision
of *this* file.

## Decision

### 1. One record, with a parent, that can only narrow

An authority record names a **subject**, a **resource scope**, a **verb set**,
a **parent authority** it derives from, and an **expiry**. Deriving produces a
record whose scope, verbs and expiry are a subset of its parent's. An attempted
widening is **refused at write time**, not silently clamped, because a clamp
hides the caller's intent from the audit trail (`INV-GA-01`).

The narrowing algebra lives once, in `packages/os-domain`, and both planes call
it. No plane reimplements "is this narrower".

### 2. The hierarchy roots at a project and terminates

Every authority has exactly one parent; following parents terminates at a
project (ADR 0038). Organizations remain the optional tier above and nothing
requires one. Delegation depth is **bounded** and cycles are refused at write
time, so evaluation cannot loop (`INV-GA-04`, `INV-GA-06`). The bound is a
decision to be made in `GA-A-03`, not an implementation detail to discover.

### 3. Revoking a parent revokes its descendants

A revoked ancestor makes every derived authority unusable on the **next read**,
not eventually (`INV-GA-07`). This is resolved as record state, before or
alongside the relationship check — not by hoping a tuple deletion propagated.

### 4. The OpenFGA delta is additive, and that has to be proven

New types and relations may only add reachable tuples: no check that returned
true against the baseline model may return false against the delta
(`INV-GA-03`). Existing definitions for `project`, `organization`, `team`,
`connection`, `vault_collection` and `vault_item` are not redefined, and
derived relations inherit (`or <rel> from <parent>`) the way `vault_item`
already inherits from `vault_collection`.

Refusal is enforced above the model, in the domain and in host-core, because
subtraction is not what an additive relation graph is for.

Additivity is currently an **assertion in prose**. It becomes a claim when
`GA-F-03` builds a harness that replays baseline checks against the delta.
Nobody should describe the delta as additive before that harness runs.
Rationale and the full argument:
[`compatibility-map.md`](../implementation/general-authority/compatibility-map.md).

### 5. Expiry publishes on the lifecycle feed

An authority's deadline is detected by the lifecycle scanner and published on
`lifecycle.*` (ADR 0074, `INV-GA-05`). No subsystem gets a private due-check.
This is what makes ADR 0079's "every grant carries a TTL" mean something at the
membership grain.

### 6. Nothing here becomes a second authority model, or a value

- A cross-device question stays an `Interaction`; an approval counts only when
  a proof's `boundDigest` equals the interaction's `requestDigest` (ADR 0086).
- A sensitive authority mutation is bound to its request digest, its decision
  verb, and the effective policy digest, and is spent once (ADR 0084,
  `INV-GA-09`).
- No authority record carries a secret value, and none implies a
  `getSecret()` affordance; agent-facing authority is ConnectionRef + Intent
  (ADR 0005, `INV-GA-02`).
- The client plane keeps **one** share ledger. ADR 0115 put connector bindings
  *into* the local share-grant ledger rather than beside it; this
  generalization extends that ledger (`INV-GA-10`).

### 7. Grant or AccessLease is a label, not a model

"AccessLease" appears nowhere in the repository at baseline. If it is adopted,
it is a **display term over the same stored record** — never a second table, a
second ledger, or a second thing a user must tell apart from a Grant
(`INV-GA-08`). The naming decision is open; the constraint is not.

### 8. The existing product contracts are untouched

Identity and Host APIs stay separate — no BFF merge (ADR 0017). Guest and
anonymous access are not gated, hidden, or conditioned on any of this, and the
tests asserting guest entry and guest-tomb isolation stay as they are
(`INV-GA-11`). Every new route, verb or action gets a capability-registry entry
or an ADR-cited exclusion (ADR 0065, `INV-GA-12`). New modules meet the 400-line
budget outright (ADR 0093).

## Consequences

- Narrowing, delegation provenance, uniform deadlines and downstream
  revocation become expressible once instead of four times.
- The cost is a new primitive on the authority path, which is the most
  security-sensitive surface in the product. That is the reason this is written
  before the code and reviewed as a proposal.
- **Unresolved and deliberately not answered here:** whether `INV-GA-07` can
  hold without tuple deletion and how it interacts with tuple caching
  (`GA-F-04`); the delegation depth bound (`GA-A-03`); which mutations count as
  "sensitive" for `INV-GA-09` (`GA-I-01`); and the Grant/AccessLease naming
  (`GA-O-03`).
- ADR 0038 and ADR 0079 are unmodified. ADR 0079 remains Proposed; if it lands,
  its row-level session grants should be derived authorities under this model
  rather than a parallel grant type — but that is a claim to test, not a
  decision taken here.
- No test, build, lint or quality gate was run for this ADR. It is documents
  only.

## Related

- [general authority (architecture stub)](../architecture/general-authority.md)
- [ownership matrix](../implementation/general-authority/ownership.md)
- [contract registry](../implementation/general-authority/contract-registry.json)
- [repository baseline](../implementation/general-authority/repository-baseline.md)
- [compatibility map](../implementation/general-authority/compatibility-map.md)
