import { describe, expect, it } from "vitest";
import {
  membershipLineageActive,
  membershipLineageActiveInSnapshot,
  type MembershipLineageEdge,
} from "../authority-membership-lineage.js";
import type { AuthorityMembershipEdgeSnapshot } from "../authority-membership-reconcile.js";

function edge(
  partial: Partial<MembershipLineageEdge> &
    Pick<
      MembershipLineageEdge,
      "cohortId" | "subjectPrincipalId" | "relation"
    >,
): MembershipLineageEdge {
  return {
    organizationId: "org:1",
    invalidatedAt: null,
    ...partial,
  };
}

function snapshot(
  partial: Partial<AuthorityMembershipEdgeSnapshot> &
    Pick<
      AuthorityMembershipEdgeSnapshot,
      "cohortId" | "subjectPrincipalId" | "relation"
    >,
): AuthorityMembershipEdgeSnapshot {
  return {
    id: `ame_${partial.subjectPrincipalId}`,
    organizationId: "org:1",
    subjectKind: "person",
    source: "invite",
    issuingAuthority: "opensesame",
    role: "member",
    invalidatedAt: null,
    ...partial,
  };
}

describe("membershipLineageActive (INV-REVOCATION Identity)", () => {
  it("accepts a live member edge with no nesting", () => {
    expect(
      membershipLineageActive(
        edge({
          cohortId: "cohort:root",
          subjectPrincipalId: "person:a",
          relation: "member",
        }),
        () => undefined,
      ),
    ).toBe(true);
  });

  it("blocks when the leaf edge is invalidated", () => {
    expect(
      membershipLineageActive(
        edge({
          cohortId: "cohort:root",
          subjectPrincipalId: "person:a",
          relation: "member",
          invalidatedAt: new Date("2026-01-01T00:00:00Z"),
        }),
        () => undefined,
      ),
    ).toBe(false);
  });

  it("walks nested_cohort parents and blocks on an invalidated ancestor", () => {
    const child = edge({
      cohortId: "cohort:child",
      subjectPrincipalId: "person:a",
      relation: "nested_cohort",
    });
    const parent = edge({
      cohortId: "cohort:root",
      subjectPrincipalId: "cohort:child",
      relation: "member",
      invalidatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(
      membershipLineageActive(child, (org, cohortId) => {
        if (org === "org:1" && cohortId === "cohort:child") return parent;
        return undefined;
      }),
    ).toBe(false);
  });

  it("denies when a nested parent edge is missing", () => {
    expect(
      membershipLineageActive(
        edge({
          cohortId: "cohort:orphan",
          subjectPrincipalId: "person:a",
          relation: "nested_cohort",
        }),
        () => undefined,
      ),
    ).toBe(false);
  });

  it("resolves against a flat snapshot list", () => {
    const leaf = snapshot({
      cohortId: "cohort:mid",
      subjectPrincipalId: "person:a",
      relation: "nested_cohort",
    });
    const edges = [
      snapshot({
        cohortId: "cohort:root",
        subjectPrincipalId: "cohort:mid",
        relation: "member",
      }),
      leaf,
    ];
    expect(membershipLineageActiveInSnapshot(leaf, edges)).toBe(true);
    const revokedParent = [
      snapshot({
        cohortId: "cohort:root",
        subjectPrincipalId: "cohort:mid",
        relation: "member",
        invalidatedAt: new Date("2026-01-03T00:00:00Z"),
      }),
      leaf,
    ];
    expect(membershipLineageActiveInSnapshot(leaf, revokedParent)).toBe(false);
  });
});
