# ADR 0121 — Durable root/ancestor invalidation fencing

Status: Accepted
Date: 2026-09-15
Supplements: ADR 0005 ([ConnectionRef / authority handles](0005-authority-handle-connectionref.md)),
ADR 0044 §8 (claimable delegation; ancestor revocation kills descendants),
ADR 0046 §10 (post-claim edits are revoke-and-replace),
ADR 0074 ([expiry lifecycle hooks](0074-expiry-lifecycle-hooks.md)),
ADR 0093 ([structural quality gates](0093-structural-quality-gates.md)),
ADR 0120 ([generalized hierarchical authority](0120-generalized-hierarchical-authority.md))

## Context

Delegated authority is a chain. An owner grant is the ceiling, a claimed
delegation narrows it, and a narrowing replacement or a re-delegation narrows
it again. ADR 0044 decision 8 already states the rule this ADR is about:
**ancestor revocation kills descendants** — a child that stays active under a
dead parent is authority that outlived the thing it narrowed.

Two implementations of that rule existed, and neither held it.

`crates/storage/src/grants.rs`'s `assert_grant_chain_active` walked
`parent_grant_id` upward, one `find_grant` query per hop, up to sixteen hops.
Correct in the small, but it is a *walk*: sixteen sequential round trips on the
authorization path, and every hop a chance for the answer to have changed under
it. It also had no callers, so nothing actually enforced the rule through it.

`crates/connection-broker/src/delegation.rs`'s `find_live_delegation` — the
function the invoke path really resolves a `ConnectionRef` against — checked
the delegation's grant and **its immediate parent, one hop, and stopped**.
That is sound only while chains are exactly two deep, which is what the owner
grant's `maximum_delegation_depth: 1` happens to make true today. The domain
has always been able to express more (`delegation_depth`,
`maximum_delegation_depth`, `validate_attenuation`), and the moment it does, a
revoked grandparent stops blocking a grandchild.

The obvious repair — cascade the revocation down to descendants — is the thing
to avoid. Pushing revocation downward makes the guarantee depend on the push
finishing. Between the owner pressing revoke and the cascade reaching a
particular child, that child is still honoured. Do it in a background job and
the window is however long the job takes; do it in a recursive transaction and
the window is smaller but the cost grows with the size of the subtree, on the
revoke path, while holding a write lock. Either way the property "revoked
means refused" is only eventually true, and an agent holding the descendant
gets to use it in the meantime.

## Decision

**Invert the direction of the work. A revoke writes one row; authorization
pulls the answer up.**

Two tables, added by `crates/storage/migrations/0033_authority_invalidation_fence.sql`:

- `grant_lineage` — one row per grant, written **in the transaction that
  writes the grant**. It holds the materialized ancestor path, root first and
  the grant itself last, delimited and terminated with `/`:
  `/grant:<root>/grant:<child>/`. A grant therefore already knows every id its
  authority depends on, with no discovery needed at request time.
- `grant_invalidations` — one row per revoked grant, `grant_id` primary key,
  with a monotonic `sequence`. Descendants are deliberately **not** enumerated
  here.

Authorization is then a set-membership test against ids the grant carries:
one indexed query returns every invalidation touching the chain, and
`opensesame-lifecycle`'s `evaluate_fence` decides. Revoking a root is a single
insert whether it has one descendant or ten thousand, and it blocks all of
them at once, because none of them was ever recorded as depending on anything
but its ancestors' ids.

### The linearization point

**A revocation takes effect at the commit of `authority_fence::fence_grant`'s
transaction.** This is the whole ordering story:

- Before that commit, a concurrent authorization may allow. It read a world in
  which the grant was live, and that read is not wrong — it is ordered before
  the revoke.
- From that commit onward, every authorization denies, including one already
  in flight that has not yet performed its fence read. There is no descendant
  to update first, so there is no interval in which "revoked" is true for the
  root and false for a child.

The transaction takes the write lock up front (`begin_write`) so that a revoke
which started earlier cannot lose its position to one that started later, and
`sequence` carries a `UNIQUE` constraint as the backstop: if two writers ever
did claim the same position, the second fails its insert and its revoke
returns an error. A failed revoke is safe — the caller retries, and meanwhile
the grant stays live, which is the pre-revoke state rather than a widening.

The `revoked_at` columns on `grants` and `connection_delegations` are updated
in the same transaction, as a single indexed range scan over the path (see
`Lineage::subtree_bounds`). They are **bookkeeping** — for listings, receipts
and the ADR 0074 expiry scanner — and deliberately not what enforces. Were
they dropped entirely, the fence would still deny every descendant. That is
the property that makes the cascade safe to be imperfect, and it is why this
is not "revoke plus cascade" wearing a new name.

### Fail closed on freshness uncertainty

`FenceVerdict` has three variants, not two, and only `Clear` authorizes:

- `Clear` — reachable only from an affirmative, complete, fresh reading of a
  well-formed lineage.
- `Invalidated` — the grant or an ancestor carries a fence row. The reported
  cause is the invalidated grant **closest to the root**, so an operator is
  told the cause rather than the nearest symptom.
- `Indeterminate` — a grant with no lineage row, a stored path that will not
  parse, a lineage row that disagrees with its own path, a reading that
  mentions grants outside the chain, a failed query, or a reading from behind
  a sequence the caller has already observed.

`Indeterminate` denies. "Could not tell" is never "probably fine": that is how
a slow query or a half-applied migration becomes a revocation bypass.
`fence_status` therefore returns `FenceVerdict` rather than
`Result<FenceVerdict>` — a caller with an `Err` in hand has somewhere to put a
`?`, and a retry that turns a database hiccup into an allow is exactly the
failure mode being designed out.

A grant with no lineage row is **not** treated as a root. Its ancestry is
unknown, and an unknown ancestry cannot be cleared. `insert_grant` therefore
writes the grant and its lineage in one transaction, so a grant is never
visible in that state, and recording a child whose parent has no lineage is
refused at write time rather than discovered at read time.

Only the grant's own clock is checked, and that is not an omission:
`Grant::validate_attenuation` refuses a child whose `expires_at` exceeds its
parent's, so a grant inside its own window is necessarily inside every
ancestor's window too. Expiry is transitive at mint time. Revocation is not —
it happens long after the chain was built — which is precisely why it needs a
fence rather than an invariant.

### Path safety

Paths are addressed as a half-open range (`>= low AND < high`) rather than a
`LIKE 'prefix%'` pattern. A range uses the path index unconditionally, where
`LIKE` only does so under the right `case_sensitive_like` pragma — so the
cascade cannot silently degrade into a table scan. The upper bound replaces the
trailing `/` (`0x2F`) with `0` (`0x30`), so the range is exactly the subtree: a
sibling whose id merely *starts* with this one's cannot be caught, because the
separator sits inside the bound. `is_fence_safe_id` additionally refuses the
separator and every pattern metacharacter, so there is no escaping to get
wrong on top of that.

## Scope — no quorum is inferred from SQLite

This is one SQLite database with one writer at a time. Within a host, the
`sequence` column is a total order and the fence is linearizable at the commit
described above. **That is the entire claim.**

It is not a consensus protocol and must not be described as one. Two hosts
pointed at two databases have two independent fences; a deployment that needs
one authority decision across hosts needs a store that actually provides
consensus. Nothing in `grant_lineage` or `grant_invalidations` may be read as
a quorum, a lease, or a fencing token in the distributed-systems sense —
inventing such a guarantee on top of a single-writer embedded database would
be claiming a property the storage engine does not offer, which is worse than
having no fence, because it would be relied upon.

## Consequences

- Revocation is O(1) writes and immediate, independent of subtree size.
- Authorization is one indexed query for the whole chain, replacing up to
  sixteen sequential round trips.
- A pure decision (`crates/lifecycle/src/fence.rs`) with no I/O and no ability
  to see a credential is unit-testable against adversarial lineages, and is
  shared by the legacy delegation path and ADR 0120's generalized authority
  sidecar, so the two cannot drift into separate opinions about ancestry.
- Migration 0033 backfills lineage for every existing grant and a fence row
  for every already-revoked one, so an upgraded deployment arrives complete
  rather than failing closed on its own live delegations.
- A grant written by any future path that forgets to record lineage denies
  until one appears. This is intended, and is the reason `insert_grant` owns
  both writes.

## Alternatives rejected

**Cascade `revoked_at` to descendants, recursively, on revoke.** The
guarantee then depends on the cascade completing, and the revoke path's cost
grows with subtree size while holding a write lock. Kept as bookkeeping only.

**Background reconciliation.** Makes the window explicitly unbounded. An agent
holding a descendant may use it until the job arrives.

**Keep the per-hop walk.** Correct but O(depth) round trips on every
authorization, and it cannot answer at all when an intermediate row is missing
— where the fence's `Indeterminate` denies, the walk's `find_grant` returning
`None` had to be turned into an error by hand at each hop.

**A generation/epoch counter per root instead of an invalidation row.**
Equivalent for whole-root revocation, but it cannot express "revoke this
intermediate and leave its siblings alone" without a per-node counter, which
is the same row count with a less obvious meaning. ADR 0120's sidecar pins
ancestor generations for its own reparent and recovery-rotation cases and
defers chain invalidation to this fence, so both mechanisms exist without
overlapping.
