import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  AddOrganizationMemberRequestSchema,
  ChangeOrganizationMemberRoleRequestSchema,
  CreateOrganizationRequestSchema,
  OrganizationMembershipResponseSchema,
  OrganizationResponseSchema,
} from "@opensesame/contracts";
import type {
  Organization,
  OrganizationMembership,
  OrganizationRole,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { getUsage } from "../state.js";

export const organizationRoutes = new Hono<{ Variables: Variables }>();

function authenticatedPrincipalId(value: string | undefined): string {
  if (!value) throw new Error("requirePrincipal middleware invariant violated");
  return value;
}

function membershipKey(organizationId: string, principalId: string): string {
  return `${organizationId}:${principalId}`;
}

function toResponse(org: Organization, role: OrganizationRole) {
  return OrganizationResponseSchema.parse({
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    state: org.state,
    role,
    createdBy: org.createdBy,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  });
}

function membershipResponse(membership: OrganizationMembership) {
  return OrganizationMembershipResponseSchema.parse({
    ...membership,
    createdAt: membership.createdAt.toISOString(),
    updatedAt: membership.updatedAt.toISOString(),
  });
}

function getMembership(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): OrganizationMembership | undefined {
  return ctx.stores.organizationMemberships.get(
    membershipKey(organizationId, principalId),
  );
}

function ownerCount(ctx: AppContext, organizationId: string): number {
  let count = 0;
  for (const membership of ctx.stores.organizationMemberships.values()) {
    if (
      membership.organizationId === organizationId &&
      membership.role === "owner"
    ) {
      count += 1;
    }
  }
  return count;
}

export async function serializeMembershipMutation<T>(
  ctx: AppContext,
  organizationId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous =
    ctx.stores.organizationMembershipMutations.get(organizationId) ??
    Promise.resolve();
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  ctx.stores.organizationMembershipMutations.set(organizationId, tail);
  await previous;
  try {
    return await mutation();
  } finally {
    release();
    if (
      ctx.stores.organizationMembershipMutations.get(organizationId) === tail
    ) {
      ctx.stores.organizationMembershipMutations.delete(organizationId);
    }
  }
}

async function revokeHostSessions(
  ctx: AppContext,
  organizationId: string,
  principalId: string,
): Promise<boolean> {
  let url: URL;
  try {
    url = new URL("/api/v1/sessions/revoke", `${ctx.config.hostApiUrl}/`);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opensesame-operator": ctx.config.operatorToken,
      },
      body: JSON.stringify({
        organization_id: organizationId,
        principal_id: principalId,
      }),
    });
    return response.ok;
  } catch (error) {
    ctx.log.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Host session revocation failed",
    );
    return false;
  }
}

organizationRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizations = [];
  for (const membership of ctx.stores.organizationMemberships.values()) {
    if (membership.principalId !== principalId) continue;
    const org = ctx.stores.organizations.get(membership.organizationId);
    if (!org || org.state === "deleted") continue;
    organizations.push(toResponse(org, membership.role));
  }
  return c.json({ organizations });
});

organizationRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("organizations.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const principal = await ctx.repos.principals.getById(principalId);
    if (!principal) {
      return c.json({ error: "not_found" }, 404);
    }
    if (principal.assurance === "provisional") {
      return c.json(
        {
          error: "assurance_too_low",
          message: "Verified identity required to create an organization",
        },
        403,
      );
    }

    // Assurance says who someone is; it does not say they may mint organizations
    // forever. Without this the store grew for as long as a caller kept asking.
    const decision = ctx.policy.evaluate(
      principal,
      {
        subject: {
          type: "principal",
          id: principal.id,
          assurance: principal.assurance,
        },
        action: "organization.create",
        resource: { type: "organization", id: "*" },
      },
      getUsage(ctx.stores, principalId, ctx.clock()),
    );
    if (decision.effect === "deny") {
      return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
    }

    const parsed = CreateOrganizationRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    if (ctx.stores.organizationSlugs.has(parsed.data.slug)) {
      return c.json({ error: "slug_taken" }, 409);
    }

    const now = ctx.clock();
    const org: Organization = {
      // Rust Host APIs use the canonical opaque-id spelling `org:<uuid>`.
      id: `org:${randomUUID()}`,
      slug: parsed.data.slug,
      displayName: parsed.data.displayName,
      state: "active",
      createdBy: principalId,
      createdAt: now,
      updatedAt: now,
    };
    ctx.stores.organizations.set(org.id, org);
    ctx.stores.organizationSlugs.set(org.slug, org.id);
    ctx.stores.organizationMemberships.set(membershipKey(org.id, principalId), {
      organizationId: org.id,
      principalId,
      role: "owner",
      createdAt: now,
      updatedAt: now,
    });

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.created",
      outcome: "succeeded",
      principalId,
      organizationId: org.id,
      correlationId: c.get("correlationId"),
      metadata: { action: "organization.create", slug: org.slug },
    });

    return c.json(toResponse(org, "owner"), 201);
  },
);

organizationRoutes.get("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizationId = c.req.param("id");
  const membership = getMembership(ctx, organizationId, principalId);
  if (!membership) return c.json({ error: "not_found" }, 404);
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  const members = [...ctx.stores.organizationMemberships.values()]
    .filter((candidate) => candidate.organizationId === organizationId)
    .map(membershipResponse);
  return c.json({ members });
});

organizationRoutes.post("/:id/members", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const organizationId = c.req.param("id");
  return serializeMembershipMutation(ctx, organizationId, async () => {
    const actor = getMembership(ctx, organizationId, principalId);
    if (!actor) return c.json({ error: "not_found" }, 404);
    if (actor.role !== "owner") {
      return c.json({ error: "owner_required" }, 403);
    }
    const parsed = AddOrganizationMemberRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }
    const principal = await ctx.repos.principals.getById(
      parsed.data.principalId,
    );
    if (!principal) return c.json({ error: "principal_not_found" }, 404);
    if (principal.state === "suspended" || principal.state === "closed") {
      return c.json({ error: "principal_inactive" }, 409);
    }
    const key = membershipKey(organizationId, principal.id);
    if (ctx.stores.organizationMemberships.has(key)) {
      return c.json({ error: "membership_exists" }, 409);
    }
    const now = ctx.clock();
    const membership: OrganizationMembership = {
      organizationId,
      principalId: principal.id,
      role: parsed.data.role,
      createdAt: now,
      updatedAt: now,
    };
    ctx.stores.organizationMemberships.set(key, membership);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.member_added",
      outcome: "succeeded",
      principalId,
      organizationId,
      correlationId: c.get("correlationId"),
      metadata: {
        action: "organization.member.add",
        memberPrincipalId: principal.id,
        role: membership.role,
      },
    });
    return c.json(membershipResponse(membership), 201);
  });
});

organizationRoutes.patch(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    return serializeMembershipMutation(ctx, organizationId, async () => {
      const actor = getMembership(ctx, organizationId, actorPrincipalId);
      if (!actor) return c.json({ error: "not_found" }, 404);
      if (actor.role !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = getMembership(ctx, organizationId, targetPrincipalId);
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      const parsed = ChangeOrganizationMemberRoleRequestSchema.safeParse(
        await c.req.json(),
      );
      if (!parsed.success) {
        return c.json(
          { error: "validation_error", details: parsed.error.flatten() },
          400,
        );
      }
      if (target.role === parsed.data.role) {
        return c.json(membershipResponse(target));
      }
      if (target.role === "owner" && ownerCount(ctx, organizationId) === 1) {
        return c.json({ error: "last_owner" }, 409);
      }
      const updated: OrganizationMembership = {
        ...target,
        role: parsed.data.role,
        updatedAt: ctx.clock(),
      };
      const key = membershipKey(organizationId, targetPrincipalId);
      // Publish the new role before yielding to Host revocation. Otherwise a
      // concurrent approval can capture the old role after Host has revoked it.
      ctx.stores.organizationMemberships.set(key, updated);
      if (!(await revokeHostSessions(ctx, organizationId, targetPrincipalId))) {
        ctx.stores.organizationMemberships.set(key, target);
        return c.json({ error: "session_revocation_failed" }, 502);
      }
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.member_role_changed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        organizationId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "organization.member.role.change",
          memberPrincipalId: targetPrincipalId,
          previousRole: target.role,
          role: updated.role,
        },
      });
      return c.json(membershipResponse(updated));
    });
  },
);

organizationRoutes.delete(
  "/:id/members/:principalId",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const actorPrincipalId = authenticatedPrincipalId(c.get("principalId"));
    const organizationId = c.req.param("id");
    return serializeMembershipMutation(ctx, organizationId, async () => {
      const actor = getMembership(ctx, organizationId, actorPrincipalId);
      if (!actor) return c.json({ error: "not_found" }, 404);
      if (actor.role !== "owner") {
        return c.json({ error: "owner_required" }, 403);
      }
      const targetPrincipalId = c.req.param("principalId");
      const target = getMembership(ctx, organizationId, targetPrincipalId);
      if (!target) return c.json({ error: "membership_not_found" }, 404);
      if (target.role === "owner" && ownerCount(ctx, organizationId) === 1) {
        return c.json({ error: "last_owner" }, 409);
      }
      const key = membershipKey(organizationId, targetPrincipalId);
      // Remove authority before yielding so no approval can mint a session in the
      // gap between revocation and this mutation. Restore it if Host fails closed.
      ctx.stores.organizationMemberships.delete(key);
      if (!(await revokeHostSessions(ctx, organizationId, targetPrincipalId))) {
        ctx.stores.organizationMemberships.set(key, target);
        return c.json({ error: "session_revocation_failed" }, 502);
      }
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.member_removed",
        outcome: "succeeded",
        principalId: actorPrincipalId,
        organizationId,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "organization.member.remove",
          memberPrincipalId: targetPrincipalId,
          role: target.role,
        },
      });
      return c.body(null, 204);
    });
  },
);

organizationRoutes.get("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const org = ctx.stores.organizations.get(c.req.param("id"));
  const membership = org && getMembership(ctx, org.id, principalId);
  if (!org || org.state === "deleted" || !membership) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(toResponse(org, membership.role));
});
