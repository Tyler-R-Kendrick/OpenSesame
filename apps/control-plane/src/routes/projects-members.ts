/**
 * Project membership CRUD — kept out of projects.ts so GA-I-02 reconcile
 * wiring does not push that module past the ADR 0093 line budget.
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  AddProjectMemberRequestSchema,
  ChangeProjectMemberRoleRequestSchema,
} from "@opensesame/contracts";
import type { ProjectMembership } from "@opensesame/os-domain";
import { requirePrincipal } from "../middleware/auth.js";
import { reconcileProjectAuthorityMembership } from "../services/project-membership-reconcile.js";
import { authenticatedPrincipalId } from "./organizations.js";
import {
  isVisible,
  membershipResponse,
  projectRoutes,
  roleFor,
  serializeProjectMutation,
} from "./projects.js";

projectRoutes.get("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const project = await ctx.stores.projects.get(c.req.param("id"));
  const role = project && (await roleFor(ctx, project, principalId));
  if (!project || !role || !isVisible(project, ctx.clock())) {
    return c.json({ error: "not_found" }, 404);
  }
  if (role === "member") {
    return c.json({ error: "admin_required" }, 403);
  }
  const members = (
    await ctx.stores.projectMemberships.listByProject(project.id)
  ).map(membershipResponse);
  return c.json({ members });
});

projectRoutes.post("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
  const projectId = c.req.param("id");
  return serializeProjectMutation(ctx, projectId, async () => {
    const project = await ctx.stores.projects.get(projectId);
    const actorRole =
      project && (await roleFor(ctx, project, actorPrincipalId));
    if (!project || !actorRole || !isVisible(project, ctx.clock())) {
      return c.json({ error: "not_found" }, 404);
    }
    if (actorRole === "member") {
      return c.json({ error: "admin_required" }, 403);
    }
    if (project.kind === "personal") {
      return c.json({ error: "personal_project_not_shareable" }, 409);
    }
    const parsed = AddProjectMemberRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    // Only an owner may mint another owner.
    if (parsed.data.role === "owner" && actorRole !== "owner") {
      return c.json({ error: "owner_required" }, 403);
    }
    const principal = await ctx.repos.principals.getById(
      parsed.data.principalId,
    );
    if (!principal) return c.json({ error: "principal_not_found" }, 404);
    if (principal.state === "suspended" || principal.state === "closed") {
      return c.json({ error: "principal_inactive" }, 409);
    }
    if (await ctx.stores.projectMemberships.find(projectId, principal.id)) {
      return c.json({ error: "membership_exists" }, 409);
    }
    const now = ctx.clock();
    const membership: ProjectMembership = {
      projectId,
      principalId: principal.id,
      role: parsed.data.role,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.stores.projectMemberships.upsert(membership);
    await reconcileProjectAuthorityMembership(ctx, projectId, {
      actorPrincipalId,
      correlationId: c.get("correlationId"),
    });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "project.member_added",
      outcome: "succeeded",
      principalId: actorPrincipalId,
      projectId,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "project.member.add",
        memberPrincipalId: principal.id,
        role: membership.role,
      },
    });
    return c.json(membershipResponse(membership), 201);
  });
});

projectRoutes.patch(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const projectId = c.req.param("id");
    return serializeProjectMutation(ctx, projectId, async () => {
      const project = await ctx.stores.projects.get(projectId);
      const actorRole =
        project && (await roleFor(ctx, project, actorPrincipalId));
      if (!project || !actorRole || !isVisible(project, ctx.clock())) {
        return c.json({ error: "not_found" }, 404);
      }
      if (actorRole === "member") {
        return c.json({ error: "admin_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = await ctx.stores.projectMemberships.find(
        projectId,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      const parsed = ChangeProjectMemberRoleRequestSchema.safeParse(
        await c.req.json(),
      );
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      // Touching the owner role in either direction takes an owner actor.
      if (
        (target.role === "owner" || parsed.data.role === "owner") &&
        actorRole !== "owner"
      ) {
        return c.json({ error: "owner_required" }, 403);
      }
      if (target.role === parsed.data.role) {
        return c.json(membershipResponse(target));
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.projectMemberships.countOwners(projectId)) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      const updated: ProjectMembership = {
        ...target,
        role: parsed.data.role,
        updatedAt: ctx.clock(),
      };
      await ctx.stores.projectMemberships.upsert(updated);
      await reconcileProjectAuthorityMembership(ctx, projectId, {
        actorPrincipalId,
        correlationId: c.get("correlationId"),
      });
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_role_changed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        projectId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.role.change",
          memberPrincipalId: targetPrincipalId,
          previousRole: target.role,
          role: updated.role,
        },
      });
      return c.json(membershipResponse(updated));
    });
  },
);

projectRoutes.delete(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const projectId = c.req.param("id");
    return serializeProjectMutation(ctx, projectId, async () => {
      const project = await ctx.stores.projects.get(projectId);
      const actorRole =
        project && (await roleFor(ctx, project, actorPrincipalId));
      if (!project || !actorRole || !isVisible(project, ctx.clock())) {
        return c.json({ error: "not_found" }, 404);
      }
      const targetPrincipalId = c.req.param("principalId");
      const leavingSelf = targetPrincipalId === actorPrincipalId;
      if (actorRole === "member" && !leavingSelf) {
        return c.json({ error: "admin_required" }, 403);
      }
      const target = await ctx.stores.projectMemberships.find(
        projectId,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      if (target.role === "owner" && actorRole !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.projectMemberships.countOwners(projectId)) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      if (project.kind === "personal") {
        return c.json({ error: "personal_project_immutable" }, 409);
      }
      await ctx.stores.projectMemberships.remove(projectId, targetPrincipalId);
      if (ctx.stores.activeProjects.get(targetPrincipalId) === projectId) {
        ctx.stores.activeProjects.delete(targetPrincipalId);
      }
      await reconcileProjectAuthorityMembership(ctx, projectId, {
        actorPrincipalId,
        correlationId: c.get("correlationId"),
      });
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_removed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        projectId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.remove",
          memberPrincipalId: targetPrincipalId,
        },
      });
      return c.body(null, 204);
    });
  },
);
