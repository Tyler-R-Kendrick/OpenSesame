/**
 * GA-F-04 — dry-run OpenFGA tuple backfill / rollback planning.
 *
 * Live writes stay on the Host projector. This module only plans additive
 * writes from GA-F-02's mapper and names quarantines / rollback deletes.
 */

import type { AuthorityGrant } from "@opensesame/os-domain";
import {
  type GrantTupleMappingError,
  type OpenFgaTupleKey,
  grantToOpenFgaTuples,
} from "./authority-tuples.js";

export type TupleBackfillWrite = {
  readonly op: "write";
  readonly tuple: OpenFgaTupleKey;
  readonly grantId: string;
};

export type TupleBackfillDelete = {
  readonly op: "delete";
  readonly tuple: OpenFgaTupleKey;
  readonly grantId: string;
};

export type TupleBackfillQuarantine = {
  readonly grantId: string;
  readonly reason: GrantTupleMappingError["code"];
  readonly message: string;
};

export type GrantTupleBackfillPlan = {
  readonly writes: readonly TupleBackfillWrite[];
  readonly quarantine: TupleBackfillQuarantine | null;
};

export type RealmTupleBackfillPlan = {
  readonly writes: readonly TupleBackfillWrite[];
  readonly quarantines: readonly TupleBackfillQuarantine[];
};

export type RealmTupleRollbackPlan = {
  readonly deletes: readonly TupleBackfillDelete[];
};

/** Plan OpenFGA writes for one grant (no I/O). */
export function planGrantTupleBackfill(
  grant: AuthorityGrant,
): GrantTupleBackfillPlan {
  const mapped = grantToOpenFgaTuples(grant);
  if (!mapped.ok) {
    return {
      writes: [],
      quarantine: {
        grantId: grant.id,
        reason: mapped.error.code,
        message: mapped.error.message,
      },
    };
  }
  const writes: TupleBackfillWrite[] = mapped.tuples.map((tuple) => ({
    op: "write",
    tuple,
    grantId: grant.id,
  }));
  return { writes, quarantine: null };
}

/** Plan a realm page: concatenate per-grant plans. */
export function planRealmTupleBackfill(
  grants: readonly AuthorityGrant[],
): RealmTupleBackfillPlan {
  const writes: TupleBackfillWrite[] = [];
  const quarantines: TupleBackfillQuarantine[] = [];
  for (const grant of grants) {
    const plan = planGrantTupleBackfill(grant);
    for (const write of plan.writes) {
      writes.push(write);
    }
    if (plan.quarantine !== null) {
      quarantines.push(plan.quarantine);
    }
  }
  return { writes, quarantines };
}

/**
 * Rollback plan for a prior apply ledger: delete only tuples that backfill
 * wrote (never baseline tuples outside the ledger).
 */
export function planTupleBackfillRollback(
  appliedWrites: readonly TupleBackfillWrite[],
): RealmTupleRollbackPlan {
  const deletes: TupleBackfillDelete[] = appliedWrites.map((write) => ({
    op: "delete",
    tuple: write.tuple,
    grantId: write.grantId,
  }));
  return { deletes };
}
