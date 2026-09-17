/**
 * GA-I-02 — apply project membership reconcile plans to durable edges.
 *
 * Skips personal projects (ADR 0038 refuse) and projects with no organization
 * realm (edges require organization_id).
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  cohortIdForProject,
  planProjectMembershipReconcile,
} from "@opensesame/os-domain";
import type { AppContext } from "../context.js";

/** Re-export so callers share the same cohort id the planner uses. */
export { cohortIdForProject };

export async function reconcileProjectAuthorityMembership(
  ctx: AppContext,
  projectId: string,
  options?: {
    readonly actorPrincipalId?: string;
    readonly correlationId?: string;
  },
): Promise<void> {
  const project = await ctx.stores.projects.get(projectId);
  if (!project) return;
  if (project.kind === "personal") return;
  const organizationId = project.organizationId;
  if (organizationId === undefined) return;

  const memberships =
    await ctx.stores.projectMemberships.listByProject(projectId);
  const cohortId = cohortIdForProject(projectId);
  const existingEdges = await ctx.stores.authorityMembershipEdges.listByCohort(
    organizationId,
    cohortId,
  );

  const result = planProjectMembershipReconcile({
    organizationId,
    projectId,
    projectKind: project.kind,
    memberships,
    existingEdges,
  });
  if (!result.ok) return;
  if (
    result.plan.upserts.length === 0 &&
    result.plan.invalidations.length === 0
  ) {
    return;
  }

  await ctx.stores.authorityMembershipEdges.applyPlan(result.plan, ctx.clock());

  const actorPrincipalId = options?.actorPrincipalId;
  if (actorPrincipalId === undefined) return;

  const correlationId = options?.correlationId;
  if (correlationId === undefined) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authority.membership.reconciled",
      outcome: "succeeded",
      principalId: actorPrincipalId,
      projectId,
      metadata: {
        action: "authority.membership.reconcile",
        organizationId,
        cohortId,
        upsertCount: result.plan.upserts.length,
        invalidateCount: result.plan.invalidations.length,
      },
    });
    return;
  }
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "authority.membership.reconciled",
    outcome: "succeeded",
    principalId: actorPrincipalId,
    projectId,
    correlationId,
    metadata: {
      action: "authority.membership.reconcile",
      organizationId,
      cohortId,
      upsertCount: result.plan.upserts.length,
      invalidateCount: result.plan.invalidations.length,
    },
  });
}
