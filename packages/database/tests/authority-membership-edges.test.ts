import type { MembershipReconcilePlan } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  type AuthorityMembershipEdgeStore,
  MemoryAuthorityMembershipEdgeStore,
} from "../src/repos/authority-membership-edges.js";

describe("AuthorityMembershipEdgeStore (GA-I-02 live apply)", () => {
  it("upserts, role-drifts, and invalidates edges in memory", async () => {
    const store: AuthorityMembershipEdgeStore =
      new MemoryAuthorityMembershipEdgeStore();
    const planAdd: MembershipReconcilePlan = {
      upserts: [
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
      ],
      invalidations: [],
    };
    await store.applyPlan(planAdd, new Date("2026-09-17T00:00:00Z"));
    let edges = await store.listByCohort("org_1", "project:prj_1");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.role).toBe("member");
    expect(edges[0]?.invalidatedAt).toBeNull();
    const edgeId = edges[0]?.id;
    expect(edgeId).toBeTruthy();

    const planDrift: MembershipReconcilePlan = {
      upserts: [
        {
          op: "upsert",
          organizationId: "org_1",
          cohortId: "project:prj_1",
          subjectPrincipalId: "prn_a",
          relation: "member",
          subjectKind: "person",
          source: "project_membership_reconcile",
          issuingAuthority: "identity.project_memberships",
          role: "admin",
        },
      ],
      invalidations: [],
    };
    await store.applyPlan(planDrift, new Date("2026-09-17T01:00:00Z"));
    edges = await store.listByCohort("org_1", "project:prj_1");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe(edgeId);
    expect(edges[0]?.role).toBe("admin");

    if (edgeId === undefined) throw new Error("edge id missing");
    const planRemove: MembershipReconcilePlan = {
      upserts: [],
      invalidations: [
        {
          op: "invalidate",
          edgeId,
          reason: "project_membership_removed",
        },
      ],
    };
    await store.applyPlan(planRemove, new Date("2026-09-17T02:00:00Z"));
    edges = await store.listByCohort("org_1", "project:prj_1");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.invalidatedAt).toEqual(new Date("2026-09-17T02:00:00Z"));
  });
});
