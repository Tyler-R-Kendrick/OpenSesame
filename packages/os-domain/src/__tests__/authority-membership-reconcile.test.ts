import { describe, expect, it } from "vitest";
import { planProjectMembershipReconcile } from "../authority-membership-reconcile.js";
import type { ProjectMembership } from "../types.js";

function membership(
  overrides: Partial<ProjectMembership> &
    Pick<ProjectMembership, "principalId" | "role">,
): ProjectMembership {
  return {
    projectId: "prj_1",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

describe("planProjectMembershipReconcile (GA-I-02)", () => {
  it("upserts missing members for a standard project", () => {
    const result = planProjectMembershipReconcile({
      organizationId: "org_1",
      projectId: "prj_1",
      projectKind: "standard",
      memberships: [membership({ principalId: "prn_a", role: "member" })],
      existingEdges: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.invalidations).toEqual([]);
    expect(result.plan.upserts).toEqual([
      {
        op: "upsert",
        organizationId: "org_1",
        cohortId: "project:prj_1",
        subjectPrincipalId: "prn_a",
        relation: "member",
        subjectKind: "person",
        source: "project_membership_reconcile",
        issuingAuthority: "identity.project_memberships",
        role: "member",
      },
    ]);
  });

  it("invalidates edges when membership is removed", () => {
    const result = planProjectMembershipReconcile({
      organizationId: "org_1",
      projectId: "prj_1",
      projectKind: "standard",
      memberships: [],
      existingEdges: [
        {
          id: "edge_1",
          organizationId: "org_1",
          cohortId: "project:prj_1",
          subjectPrincipalId: "prn_a",
          relation: "member",
          subjectKind: "person",
          source: "project_membership_reconcile",
          issuingAuthority: "identity.project_memberships",
          role: "member",
          invalidatedAt: null,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.upserts).toEqual([]);
    expect(result.plan.invalidations).toEqual([
      {
        op: "invalidate",
        edgeId: "edge_1",
        reason: "project_membership_removed",
      },
    ]);
  });

  it("refuses personal projects that still carry membership rows", () => {
    const result = planProjectMembershipReconcile({
      organizationId: "org_1",
      projectId: "prj_personal",
      projectKind: "personal",
      memberships: [membership({ principalId: "prn_a", role: "owner" })],
      existingEdges: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("personal_project");
  });

  it("upserts when an active edge role drifts", () => {
    const result = planProjectMembershipReconcile({
      organizationId: "org_1",
      projectId: "prj_1",
      projectKind: "standard",
      memberships: [membership({ principalId: "prn_a", role: "admin" })],
      existingEdges: [
        {
          id: "edge_1",
          organizationId: "org_1",
          cohortId: "project:prj_1",
          subjectPrincipalId: "prn_a",
          relation: "member",
          subjectKind: "person",
          source: "project_membership_reconcile",
          issuingAuthority: "identity.project_memberships",
          role: "member",
          invalidatedAt: null,
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.invalidations).toEqual([]);
    expect(result.plan.upserts[0]?.role).toBe("admin");
  });
});
