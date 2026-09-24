import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import {
  cohortIdForProject,
  reconcileProjectAuthorityMembership,
} from "../services/project-membership-reconcile.js";

function testConfig() {
  return {
    port: 0,
    publicUrl: "http://127.0.0.1:8788",
    issuer: "http://127.0.0.1:8788",
  } as const;
}

describe("GA-I-02 live membership reconcile", () => {
  it("applies upserts and emits authority.membership.reconciled", async () => {
    const { ctx } = createControlPlane({ config: testConfig() });
    const orgId = "org_live_reconcile";
    const ownerId = "prn_owner_live";
    const memberId = "prn_member_live";
    const projectId = "prj_live_reconcile";
    const now = ctx.clock();

    await ctx.repos.principals.create({
      id: ownerId,
      state: "active",
      assurance: "verified",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.principals.create({
      id: memberId,
      state: "active",
      assurance: "verified",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.organizations.set(orgId, {
      id: orgId,
      slug: "live-reconcile",
      displayName: "Live Reconcile",
      state: "active",
      createdBy: ownerId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.projects.set(projectId, {
      id: projectId,
      kind: "standard",
      organizationId: orgId,
      slug: "live",
      displayName: "Live",
      state: "active",
      ownerPrincipalId: ownerId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.projectMemberships.upsert({
      projectId,
      principalId: ownerId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.stores.projectMemberships.upsert({
      projectId,
      principalId: memberId,
      role: "member",
      createdAt: now,
      updatedAt: now,
    });

    await reconcileProjectAuthorityMembership(ctx, projectId, {
      actorPrincipalId: ownerId,
      correlationId: "corr-live-1",
    });

    const edges = await ctx.stores.authorityMembershipEdges.listByCohort(
      orgId,
      cohortIdForProject(projectId),
    );
    const active = edges.filter((edge) => edge.invalidatedAt === null);
    expect(active).toHaveLength(2);
    expect(active.map((edge) => edge.subjectPrincipalId).sort()).toEqual(
      [memberId, ownerId].sort(),
    );

    const audits = await ctx.repos.auditEvents.list({ limit: 20 });
    expect(
      audits.some(
        (event) => event.eventType === "authority.membership.reconciled",
      ),
    ).toBe(true);
  });
});
