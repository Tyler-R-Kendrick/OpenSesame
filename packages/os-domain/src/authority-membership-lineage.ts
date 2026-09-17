/**
 * INV-REVOCATION — Identity eligibility lineage for nested cohorts.
 *
 * Identity does not issue AuthorityGrants (Host owns grants). Nested cohort
 * membership is the Identity-plane lineage: a subject is eligible only when
 * every ancestor nested_cohort edge is still live. An invalidated ancestor
 * blocks descendants without a background tree walk at read time.
 */

import type {
  AuthorityMembershipEdgeSnapshot,
  MembershipEdgeRelation,
} from "./authority-membership-reconcile.js";

export type MembershipLineageEdge = {
  readonly organizationId: string;
  readonly cohortId: string;
  readonly subjectPrincipalId: string;
  readonly relation: MembershipEdgeRelation;
  readonly invalidatedAt: Date | string | null;
};

const MAX_NESTING_DEPTH = 32;

function isLive(edge: MembershipLineageEdge): boolean {
  return edge.invalidatedAt === null;
}

/**
 * Walk nested_cohort ancestry from `start` upward. Returns false when any hop
 * is missing, invalidated, or the depth cap is exceeded.
 */
export function membershipLineageActive(
  start: MembershipLineageEdge,
  lookupParent: (
    organizationId: string,
    childCohortId: string,
  ) => MembershipLineageEdge | undefined,
): boolean {
  let current: MembershipLineageEdge = start;
  for (let depth = 0; depth <= MAX_NESTING_DEPTH; depth += 1) {
    if (!isLive(current)) return false;
    if (current.relation !== "nested_cohort") {
      return true;
    }
    const parent = lookupParent(current.organizationId, current.cohortId);
    if (parent === undefined) return false;
    current = parent;
  }
  return false;
}

/**
 * Build a parent lookup over a flat edge list: a nested_cohort edge's parent is
 * the live edge whose subjectPrincipalId equals the child's cohortId.
 */
export function membershipLineageActiveInSnapshot(
  start: AuthorityMembershipEdgeSnapshot,
  edges: readonly AuthorityMembershipEdgeSnapshot[],
): boolean {
  const bySubject = new Map<string, AuthorityMembershipEdgeSnapshot>();
  for (const edge of edges) {
    if (edge.organizationId !== start.organizationId) continue;
    if (edge.invalidatedAt !== null) continue;
    bySubject.set(edge.subjectPrincipalId, edge);
  }
  return membershipLineageActive(start, (organizationId, childCohortId) => {
    const parent = bySubject.get(childCohortId);
    if (parent === undefined) return undefined;
    if (parent.organizationId !== organizationId) return undefined;
    return parent;
  });
}
