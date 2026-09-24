# General authority — storage layer

What the two stores hold for hierarchical authority, which process is allowed to
write each table, and what the store refuses rather than guesses.

Scope: `STO-SCHEMA`, `STO-ATOMIC`, `STO-PROJECT`, `STO-MIGRATE`, `STO-RESTORE`
(the storage slice of `GA-H` and the `packages/database` slice of `GA-I` in
[`ownership.md`](ownership.md)). Design: [ADR 0120](../../adr/0120-generalized-hierarchical-authority.md).

## 1. No parallel store

There is no `AccessLease` table and no second grant table. Generalized authority
is a **sidecar on the existing `grants` row**: `grant_authority` carries the
lineage, the policy digest, the remaining delegation depth and the pinned
generations, keyed by `(grant_id, organization_id)` with a foreign key onto
`grants`. A grant therefore cannot exist in the generalized model without
existing in the model the gateway already revokes, expires and audits — a
revocation that predates this work still ends the authority, because
`fenced_authority` joins `grants.revoked_at` in the same predicate.

Ancestry and per-grant revocation are **not** reimplemented here either. They
belong to the invalidation fence (`crates/storage/migrations/0033_authority_invalidation_fence.sql`,
`crates/storage/src/authority_fence.rs`): `issue_authority` records the child's
lineage through `record_lineage`, and `fenced_authority` asks `fence_status` for
the chain verdict. Two ancestry tables would eventually disagree, and the
disagreement would be a privilege escalation rather than a bug.

## 2. Migration IDs

| Plane | ID | Adds |
|---|---|---|
| Host (`crates/storage`) | `0034_general_authority` | `access_domains`, `authority_generations`, `grant_authority`, `grant_permission_entries`, `grant_offers`, `grant_offer_activations`, `authority_budgets`, `authority_budget_reservations`, `authority_provider_effects`, `authority_evidence`, `authority_projections`, `authority_writer_lease`, `authority_operational_generation`, `authority_backfill_progress`, `authority_backfill_quarantine`, `authority_client_floor` |
| Identity (`packages/database`) | `0024_authority_membership` | `authority_membership_edges`, `authority_projection_state` |

Host migrations are applied in order by `crates/storage/src/migrations.rs`;
`0033` is the sibling fence and stays ahead of `0034`, which depends on it.
The Identity migration follows `0023_naive_meltdown` and is generated from
`packages/database/src/schema/authority.ts` (registered in `drizzle.config.ts`
alongside `schema/index.ts`, which is at its structural size budget).

Every Host table takes `organization_id` as part of its primary key or its
unique index, and every predicate names it. A realm is part of a row's identity,
not a filter a caller is trusted to remember: a query that forgets the realm
does not silently widen, it fails to match.

## 3. Writer topology

Competing writers are not merged, they are refused. `authority_writer_lease`
holds one row per store with a monotonic fence token; `acquire_writer_lease`
advances the token and `assert_writer_lease` refuses a holder whose token is no
longer current. A second gateway that comes up and starts projecting does not
interleave with the first — its first write fails.

| Table | Sole writer | Readers |
|---|---|---|
| `access_domains`, `authority_generations` | Host API (`crates/gateway`) | host-core evaluation, projections |
| `grant_authority`, `grant_permission_entries` | Host API, at issuance | evaluation, receipts |
| `grant_lineage`, `grant_invalidations` (0033) | the invalidation fence | `fenced_authority` |
| `authority_budgets`, `authority_budget_reservations` | Host API, in the invoke transaction | budget verdicts |
| `authority_provider_effects` | the provider reconciler | operators, drift reports |
| `authority_projections` | the lease holder | freshness fences |
| `authority_operational_generation` | recovery procedure only | every fenced read |
| `authority_backfill_*`, `authority_client_floor` | the backfill pass | operators |
| `authority_membership_edges` | Identity API | cohort resolution |
| `authority_projection_state` | the Identity projector | Identity-side fences |

Nothing in the client plane writes any of these. `apps/pages` keeps its local
share grants where they are; this store is not reachable from a browser.

## 4. Atomicity

Every state change and the event announcing it commit in one transaction through
`append_outbox_tx`, so there is no window in which authority exists and the feed
does not know: `authority.domain.created`, `authority.domain.reparented`,
`authority.domain.terminated`, `authority.grant.issued`, `authority.realm.fenced`,
`authority.offer.created`, `authority.offer.activated`, `authority.offer.revoked`,
`authority.budget.reserved`, `authority.budget.finalized`,
`authority.effect.desired`, `authority.projection.dirty`,
`authority.recovery.generation_advanced`.

Compare-and-swap is by `revision`, scoped to the realm. `reparent_access_domain`
takes the revision the caller read; a stale revision moves nothing and says so,
rather than applying to whatever the row has become. Reparenting also recomputes
subtree depth and refuses a move into its own subtree, because a cycle in the
forest would make chain evaluation non-terminating.

Budgets conserve capacity in the database, not in a service. `authority_budgets`
holds capacity, capacity allocated to children, settled usage and outstanding
reservations, with `CHECK` constraints that make over-allocation unrepresentable:
a hundred children cannot multiply one root's budget, because the sum is checked
where it is stored. `reserve_authority_budget` is keyed by an idempotency key, so
a retried reservation holds the same capacity once. An unknown provider outcome
stays **charged** — releasing on uncertainty is how a spend cap becomes advisory.

## 5. Projections

A projection is a cache with a stated position, never an authority. Each row in
`authority_projections` carries the revision the authority committed, the
revision the projection has applied, and the authorization-model id it was
applied under. `projection_applied` is the fence: it is satisfied only when the
applied revision has reached the required one **under the same model id**. A
tuple written under another `OpenFGA` model does not count, and a subject with no
row at all is unknown, not fresh — unknown denies.

`mark_projection_dirty` is called in the same transaction as the authority
change, so a projector cannot miss the work it has to do. A projection may not
report a revision the authority never committed, and may not move backwards; a
failed apply records its error and stays dirty.

## 6. Migration of legacy grants

`backfill_legacy_grants` translates existing grants into the generalized model in
resumable batches, and refuses to start until `record_backfill_backup` has
recorded a verified backup.

- **Stable identity.** A translated grant keeps its grant id and its validity
  window. The sidecar is added; the row is not rewritten under a new id.
- **No widening.** A legacy grant gains no delegation depth — it can be used, not
  re-delegated — and its permission entries are derived from what the legacy body
  actually said. A body that cannot be translated is not approximated.
- **Quarantine over guessing.** Malformed, expired and revoked records go to
  `authority_backfill_quarantine` with a reason, and are not usable authority. A
  grant from another realm is out of scope for that pass rather than quarantined,
  because it is somebody else's row and not a defect.
- **Resumable.** `authority_backfill_progress` records the cursor; a crashed pass
  resumes where it stopped and a repeated pass writes nothing.
- **Incompatible clients are refused by name.** `set_client_floor` records the
  minimum client revision and `assert_client_revision` refuses anything below it
  with the required revision in the message, so an old client is told what to do
  instead of silently reading a model it does not understand.

## 7. Restore and failover

A restore is the case where every other fence is intact and still wrong: the
tokens, reservations and projections in a restored file were all valid when the
snapshot was taken. `authority_operational_generation` holds one generation for
the database, and every `grant_authority` row pins the generation it was issued
under, so `advance_recovery_generation` invalidates all pre-restore authority in
one write — without visiting a row.

Recovery, in one transaction: advance the generation, void every outstanding
reservation while keeping settled usage (spend that happened, happened; capacity
merely *held* by a process that no longer exists must not stay held), mark every
projection dirty, bump each realm's generation, and append
`authority.recovery.generation_advanced`.

`assert_operational_generation` compares the store against an outside witness and
refuses two situations that look identical from inside: a generation *lower* than
the witness (a rolled-back file replayed as current) and a different database
identity (a copy presented as the original). Both deny; neither is repaired
automatically. After recovery, authority must be reissued — a client holding a
pre-restore grant is denied at the fence, not offered a grace period.

## 8. Tests

`cargo +1.88.0 test -p opensesame-storage` (Host plane). The suites are
adversarial by design: each names the escalation it is trying to perform.

| Suite | Covers |
|---|---|
| `tests/authority_schema.rs` (8) | realm-scoped constraints: a cross-realm parent, a stale reparent revision, a cycle, entry correlation, authority with no entries, an inactive domain, an offer cap, a child window outlasting its parent |
| `tests/authority_atomic.rs` (7) | budget conservation across a hundred children, a retried reservation, an unknown provider outcome staying charged, a parent revoke denying its child at the commit, realm fencing, a late provider observation losing to a newer revoke |
| `tests/authority_projection.rs` (8) | applied-revision fences, an absent projection denying, another model id not satisfying a fence, no backward movement, a failed apply staying dirty, one writer holding the lease and the other refused by its own fence token |
| `tests/authority_migrate.rs` (6) | backfill refused without a backup, a translated grant keeping its window and gaining no delegation, malformed/expired/revoked quarantined, another realm out of scope, a crashed pass resuming, a client below the floor refused by name |
| `tests/authority_restore.rs` (6) | recovery invalidating pre-restore authority without visiting a row, held capacity voided and spend kept, projection state discarded, reissue required, a rolled-back file and a different file both fenced |
| `tests/authority_fence.rs` (19, sibling) | chain verdicts, revocation ordering, idempotent revoke — consumed here rather than duplicated |

Shared fixtures are in `tests/authority_support/mod.rs`, which seeds rows with
raw SQL on purpose: a test that can only build valid states cannot prove the
store rejects invalid ones.
