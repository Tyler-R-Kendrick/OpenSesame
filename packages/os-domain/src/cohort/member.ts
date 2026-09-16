/**
 * One row of a cohort's membership — the membership edge.
 *
 * The `kind` tags (`principal`, `team`, `cohort`) and the field names are
 * persisted and digest-bound in the Rust plane. Do not rename them: renaming
 * silently invalidates every snapshot taken before the rename.
 */

/** Wire tags for a membership edge. Frozen; do not rename. */
export const COHORT_MEMBER_KIND_WIRE = ["principal", "team", "cohort"] as const;

export type CohortMemberKind = (typeof COHORT_MEMBER_KIND_WIRE)[number];

/** One named principal. For somebody no existing group describes. */
export interface PrincipalMember {
  readonly kind: "principal";
  readonly principalId: string;
}

/**
 * An existing team, by reference. The reuse path: the team's roster stays the
 * team's, and this cohort follows it.
 */
export interface TeamMember {
  readonly kind: "team";
  readonly teamId: string;
}

/** Another cohort, nested. Bounded by `MAX_COHORT_DEPTH`. */
export interface NestedCohortMember {
  readonly kind: "cohort";
  readonly cohortId: string;
}

/**
 * One membership edge.
 *
 * Being named here is eligibility to be bound, never authority of its own. A
 * group never acts; a named principal acts, and the group is only why they were
 * allowed to.
 */
export type CohortMember = PrincipalMember | TeamMember | NestedCohortMember;

/** Alias matching the Identity-plane "membership edge" vocabulary. */
export type MembershipEdge = CohortMember;

export function principalMember(principalId: string): PrincipalMember {
  return { kind: "principal", principalId };
}

export function teamMember(teamId: string): TeamMember {
  return { kind: "team", teamId };
}

export function nestedCohortMember(cohortId: string): NestedCohortMember {
  return { kind: "cohort", cohortId };
}

/** The nested cohort this edge names, if it names one. */
export function nestedCohortOf(member: CohortMember): string | undefined {
  return member.kind === "cohort" ? member.cohortId : undefined;
}

/**
 * Whether this edge admits principals without descending into another cohort.
 * A path's last hop is always a leaf.
 */
export function isLeafMember(member: CohortMember): boolean {
  return nestedCohortOf(member) === undefined;
}

/**
 * Stable total order matching Rust's `Ord` on the tagged enum: kind first, then
 * the id string. Used so the same membership always serializes (and digests)
 * the same way.
 */
export function compareCohortMembers(a: CohortMember, b: CohortMember): number {
  const kindOrder =
    COHORT_MEMBER_KIND_WIRE.indexOf(a.kind) -
    COHORT_MEMBER_KIND_WIRE.indexOf(b.kind);
  if (kindOrder !== 0) return kindOrder;
  return memberId(a).localeCompare(memberId(b));
}

function memberId(member: CohortMember): string {
  switch (member.kind) {
    case "principal":
      return member.principalId;
    case "team":
      return member.teamId;
    case "cohort":
      return member.cohortId;
  }
}

/** Whether two edges name the same membership. */
export function sameCohortMember(a: CohortMember, b: CohortMember): boolean {
  return compareCohortMembers(a, b) === 0;
}
