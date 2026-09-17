# OpenFGA tuple backfill and rollback (GA-F-04)

Status: planned + dry-run harness in `@opensesame/policy`. Live apply stays
behind the Host projector lease (`authority_writer_lease`) and is not agent-
reachable.

Invariants: **INV-GA-03** (additive only — never revoke a baseline allow) and
**INV-GA-07** (revoked / inactive grants project nothing).

## 1. What is backfilled

For every **active** Host `Grant` in a realm, derive the OpenFGA tuple keys via
`grantToOpenFgaTuples` (GA-F-02). Opaque resource selectors do not invent object
ids; connection / project / typed vault / access_domain scopes do.

A grant that the mapper refuses (`revoked`, `cohort_grantee`, `unmapped_scope`,
empty actions/resources) is **quarantined** for the pass — never approximated.

## 2. Preconditions (refuse to start otherwise)

1. `record_backfill_backup` (or equivalent) has a verified snapshot for the
   store / OpenFGA store id being touched.
2. The authorization **model id** pinned in `authority_projections` matches the
   model the mapper was built against (`policy/openfga/model.fga`).
3. The caller holds a current `authority_writer_lease` fence token.
4. Dry-run has been reviewed for the realm (see §4).

## 3. Apply algorithm

1. Page active grants by `(organization_id, grant_id)` cursor
   (`authority_backfill_progress`).
2. For each grant, call `planGrantTupleBackfill` (dry-run first in CI; live only
   with the lease).
3. `WRITE` the planned tuples under the pinned model id.
4. `record_projection_applied` for the grant's authority revision.
5. Advance the cursor; crash-resume must rewrite nothing already applied.

A second writer whose lease token is stale is refused — it does not interleave.

## 4. Dry-run

`planGrantTupleBackfill` / `planRealmTupleBackfill` return the would-be writes
and quarantines without touching OpenFGA. Operators (and CI) review:

- every write is a tuple the mapper already unit-tests;
- quarantines name a reason code;
- no cohort-shaped user or object appears.

## 5. Rollback

Rollback is **not** "restore a DB dump over a live PDP". It is:

1. For the backfill generation / cursor range being undone, `DELETE` only the
   tuples that generation wrote (tracked per grant in the apply ledger), **or**
2. Mark every affected projection dirty and re-run the projector from source
   grants under the previous model id.

Either path must leave baseline checks from GA-F-03 still allowed (INV-GA-03).
Never delete baseline tuples that pre-existed the backfill.

## 6. Evidence commands

```bash
pnpm --filter @opensesame/policy exec vitest run \
  src/__tests__/authority-tuple-backfill.test.ts
```

Live OpenFGA apply remains optional / operator-gated and is not required to
mark GA-F-04's **plan + dry-run harness** verified.
