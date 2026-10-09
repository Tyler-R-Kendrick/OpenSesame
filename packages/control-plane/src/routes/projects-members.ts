/**
 * Project membership CRUD — kept out of projects.ts so GA-I-02 reconcile
 * wiring does not push that module past the ADR 0093 line budget.
 *
 * Every handler runs under `asProjectMember` (ADR 0178): the role lookup, the
 * visibility test and the 404 live in one proof, and each write goes through
 * `services/project-admin.ts`, which will not run without the proof that
 * matches the project and, for an owner, the proof that the actor is one.
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  AddProjectMemberRequestSchema,
  ChangeProjectMemberRoleRequestSchema,
} from "@opensesame/contracts";
import type { ProjectMembership } from "@opensesame/os-domain";
import { requirePrincipal } from "../middleware/auth.js";
import {
  grantMembership,
  grantOwnerMembership,
  leaveProject,
  reconcileMembership,
  revokeMembership,
  revokeOwnerMembership,
} from "../services/project-admin.js";
import { asProjectMember } from "./project-role-gate.js";
import { membershipResponse, projectRoutes } from "./projects.js";

projectRoutes.get("/:id/members", requirePrincipal(), (c) =>
  asProjectMember(c, { serialize: false }, async ({ ctx, access }) => {
    if (access.role === "member") {
      return c.json({ error: "admin_required" }, 403);
    }
    const members = (
      await ctx.stores.projectMemberships.listByProject(access.project.id)
    ).map(membershipResponse);
    return c.json({ members });
  }),
);

projectRoutes.post("/:id/members", requirePrincipal(), (c) =>
  asProjectMember(
    c,
    { serialize: true },
    async ({ ctx, actor, project, access }) => {
      if (access.role === "member") {
        return c.json({ error: "admin_required" }, 403);
      }
      if (access.project.kind === "personal") {
        return c.json({ error: "personal_project_not_shareable" }, 409);
      }
      const parsed = AddProjectMemberRequestSchema.safeParse(
        await c.req.json(),
      );
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      // Only an owner may mint another owner.
      const role = parsed.data.role;
      let write: (membership: ProjectMembership) => Promise<void>;
      if (access.role === "owner") {
        const owner = access.owner;
        write = (m) => grantOwnerMembership(ctx, project, owner, m);
      } else if (role === "owner") {
        return c.json({ error: "owner_required" }, 403);
      } else {
        const admin = access.admin;
        write = (m) => grantMembership(ctx, project, admin, { ...m, role });
      }
      const principal = await ctx.repos.principals.getById(
        parsed.data.principalId,
      );
      if (!principal) return c.json({ error: "principal_not_found" }, 404);
      if (principal.state === "suspended" || principal.state === "closed") {
        return c.json({ error: "principal_inactive" }, 409);
      }
      if (
        await ctx.stores.projectMemberships.find(project.value, principal.id)
      ) {
        return c.json({ error: "membership_exists" }, 409);
      }
      const now = ctx.clock();
      const membership: ProjectMembership = {
        projectId: project.value,
        principalId: principal.id,
        role,
        createdAt: now,
        updatedAt: now,
      };
      await write(membership);
      await reconcileMembership(
        ctx,
        actor,
        project,
        access.member,
        c.get("correlationId"),
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_added",
        outcome: "succeeded",
        principalId: actor.value,
        projectId: project.value,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.add",
          memberPrincipalId: principal.id,
          role: membership.role,
        },
      });
      return c.json(membershipResponse(membership), 201);
    },
  ),
);

projectRoutes.patch("/:id/members/:principalId", requirePrincipal(), (c) =>
  asProjectMember(
    c,
    { serialize: true },
    async ({ ctx, actor, project, access }) => {
      if (access.role === "member") {
        return c.json({ error: "admin_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = await ctx.stores.projectMemberships.find(
        project.value,
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
      const role = parsed.data.role;
      let write: (membership: ProjectMembership) => Promise<void>;
      if (access.role === "owner") {
        const owner = access.owner;
        write = (m) => grantOwnerMembership(ctx, project, owner, m);
      } else if (target.role === "owner" || role === "owner") {
        return c.json({ error: "owner_required" }, 403);
      } else {
        const admin = access.admin;
        write = (m) => grantMembership(ctx, project, admin, { ...m, role });
      }
      if (target.role === role) {
        return c.json(membershipResponse(target));
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.projectMemberships.countOwners(project.value)) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      const updated: ProjectMembership = {
        ...target,
        role,
        updatedAt: ctx.clock(),
      };
      await write(updated);
      await reconcileMembership(
        ctx,
        actor,
        project,
        access.member,
        c.get("correlationId"),
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_role_changed",
        outcome: "succeeded",
        principalId: actor.value,
        projectId: project.value,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.role.change",
          memberPrincipalId: targetPrincipalId,
          previousRole: target.role,
          role: updated.role,
        },
      });
      return c.json(membershipResponse(updated));
    },
  ),
);

projectRoutes.delete("/:id/members/:principalId", requirePrincipal(), (c) =>
  asProjectMember(
    c,
    { serialize: true },
    async ({ ctx, actor, project, access }) => {
      const targetPrincipalId = c.req.param("principalId");
      // A member may only remove themselves; admins and owners remove others.
      let revoke: () => Promise<void>;
      if (targetPrincipalId === actor.value) {
        revoke = () => leaveProject(ctx, actor, project, access.member);
      } else if (access.role === "member") {
        return c.json({ error: "admin_required" }, 403);
      } else if (access.role === "owner") {
        const owner = access.owner;
        revoke = () =>
          revokeOwnerMembership(ctx, project, owner, targetPrincipalId);
      } else {
        const admin = access.admin;
        revoke = () => revokeMembership(ctx, project, admin, targetPrincipalId);
      }
      const target = await ctx.stores.projectMemberships.find(
        project.value,
        targetPrincipalId,
      );
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      if (target.role === "owner" && access.role !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      if (
        target.role === "owner" &&
        (await ctx.stores.projectMemberships.countOwners(project.value)) === 1
      ) {
        return c.json({ error: "last_owner" }, 409);
      }
      if (access.project.kind === "personal") {
        return c.json({ error: "personal_project_immutable" }, 409);
      }
      await revoke();
      await reconcileMembership(
        ctx,
        actor,
        project,
        access.member,
        c.get("correlationId"),
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "project.member_removed",
        outcome: "succeeded",
        principalId: actor.value,
        projectId: project.value,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "project.member.remove",
          memberPrincipalId: targetPrincipalId,
        },
      });
      return c.body(null, 204);
    },
  ),
);
