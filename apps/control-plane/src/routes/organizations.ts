import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  AddOrganizationMemberRequestSchema,
  ChangeOrganizationMemberRoleRequestSchema,
  CreateOrganizationRequestSchema,
  JoinOrganizationTenantRequestSchema,
  OrganizationMembershipResponseSchema,
  OrganizationResponseSchema,
  OrganizationTenantResponseSchema,
  UpdateOrganizationRequestSchema,
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
import { serializeKeyed } from "../serialize.js";
import { getUsage } from "../state.js";
import { OrgAssertionError, verifyOrgIdToken } from "./org-assertion.js";

export const organizationRoutes = new Hono<{ Variables: Variables }>();

export function authenticatedPrincipalId(value: string | undefined): string {
  if (!value) throw new Error("requirePrincipal middleware invariant violated");
  return value;
}

export function ensurePersonalOrganization(
  ctx: AppContext,
  principalId: string,
): OrganizationMembership {
  for (const membership of ctx.stores.organizationMemberships.values()) {
    if (membership.principalId === principalId) {
      return membership;
    }
  }
  const now = ctx.clock();
  const organization: Organization = {
    id: `org:${randomUUID()}`,
    slug: `local-${randomUUID().slice(0, 8)}`,
    displayName: "Personal workspace",
    state: "active",
    createdBy: principalId,
    createdAt: now,
    updatedAt: now,
  };
  const membership: OrganizationMembership = {
    organizationId: organization.id,
    principalId,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  };
  ctx.stores.organizations.set(organization.id, organization);
  ctx.stores.organizationSlugs.set(organization.slug, organization.id);
  ctx.stores.organizationMemberships.set(
    membershipKey(organization.id, principalId),
    membership,
  );
  return membership;
}

export function membershipKey(
  organizationId: string,
  principalId: string,
): string {
  return `${organizationId}:${principalId}`;
}

export function hostApiEndpoint(
  configuredUrl: string,
  path: string,
): URL | undefined {
  try {
    const base = new URL(configuredUrl);
    if (
      (base.protocol !== "http:" && base.protocol !== "https:") ||
      base.username ||
      base.password
    ) {
      return undefined;
    }
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return new URL(path.replace(/^\/+/, ""), base);
  } catch {
    return undefined;
  }
}

function toResponse(org: Organization, role: OrganizationRole) {
  const response = {
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    state: org.state,
    role,
    createdBy: org.createdBy,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  };
  if (org.ssoIssuer) response.ssoIssuer = org.ssoIssuer;
  if (org.samlIssuer) response.samlIssuer = org.samlIssuer;
  return OrganizationResponseSchema.parse(response);
}

function tenantAuthMethods(org: Organization) {
  const methods = [];
  if (org.ssoIssuer) {
    methods.push({
      kind: "sso" as const,
      label: "SSO",
      issuer: org.ssoIssuer,
    });
  }
  if (org.samlIssuer) {
    methods.push({
      kind: "saml" as const,
      label: "SAML",
      issuer: org.samlIssuer,
    });
  }
  return methods;
}

function orgBySlug(ctx: AppContext, slug: string): Organization | undefined {
  const id = ctx.stores.organizationSlugs.get(slug);
  if (!id) return undefined;
  const org = ctx.stores.organizations.get(id);
  if (!org || org.state === "deleted" || org.state === "suspended") {
    return undefined;
  }
  return org;
}

function issuerForMethod(
  org: Organization,
  method: "sso" | "saml",
): string | undefined {
  return method === "sso" ? org.ssoIssuer : org.samlIssuer;
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
  const url = hostApiEndpoint(ctx.config.hostApiUrl, "api/v1/sessions/revoke");
  if (!url) return false;

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
      signal: AbortSignal.timeout(5_000),
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

    const parsed = CreateOrganizationRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    return serializeKeyed(
      ctx.stores.principalMutations,
      principalId,
      async () => {
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
          await getUsage(ctx.stores, principalId, ctx.clock()),
        );
        if (decision.effect === "deny") {
          return c.json({ error: "forbidden", reasons: decision.reasons }, 403);
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
        if (parsed.data.ssoIssuer) org.ssoIssuer = parsed.data.ssoIssuer;
        if (parsed.data.samlIssuer) org.samlIssuer = parsed.data.samlIssuer;
        ctx.stores.organizations.set(org.id, org);
        ctx.stores.organizationSlugs.set(org.slug, org.id);
        ctx.stores.organizationMemberships.set(
          membershipKey(org.id, principalId),
          {
            organizationId: org.id,
            principalId,
            role: "owner",
            createdAt: now,
            updatedAt: now,
          },
        );

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
  },
);

organizationRoutes.get("/tenants/:slug", async (c) => {
  const ctx = c.get("ctx");
  const org = orgBySlug(ctx, c.req.param("slug"));
  if (!org) return c.json({ error: "not_found" }, 404);
  return c.json(
    OrganizationTenantResponseSchema.parse({
      slug: org.slug,
      displayName: org.displayName,
      state: org.state,
      authMethods: tenantAuthMethods(org),
    }),
  );
});

organizationRoutes.post(
  "/tenants/:slug/join",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const org = orgBySlug(ctx, c.req.param("slug"));
    if (!org) return c.json({ error: "not_found" }, 404);

    const parsed = JoinOrganizationTenantRequestSchema.safeParse(
      await c.req.json(),
    );
    if (!parsed.success) {
      return c.json(
        { error: "validation_error", details: parsed.error.flatten() },
        400,
      );
    }

    const issuer = issuerForMethod(org, parsed.data.method);
    if (!issuer) {
      return c.json({ error: "auth_method_unavailable" }, 409);
    }

    try {
      await verifyOrgIdToken(parsed.data.idToken, issuer);
    } catch (error) {
      if (error instanceof OrgAssertionError) {
        const status = error.code === "upstream_unavailable" ? 502 : 401;
        return c.json({ error: error.code, message: error.message }, status);
      }
      throw error;
    }

    return serializeMembershipMutation(ctx, org.id, async () => {
      const existing = getMembership(ctx, org.id, principalId);
      if (existing) return c.json(toResponse(org, existing.role));

      const now = ctx.clock();
      const membership: OrganizationMembership = {
        organizationId: org.id,
        principalId,
        role: "member",
        createdAt: now,
        updatedAt: now,
      };
      ctx.stores.organizationMemberships.set(
        membershipKey(org.id, principalId),
        membership,
      );
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "organization.member_joined",
        outcome: "succeeded",
        principalId,
        organizationId: org.id,
        correlationId: c.get("correlationId"),
        metadata: {
          action: "organization.tenant.join",
          method: parsed.data.method,
        },
      });
      return c.json(toResponse(org, "member"), 201);
    });
  },
);

organizationRoutes.patch("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const org = ctx.stores.organizations.get(c.req.param("id"));
  const membership = org && getMembership(ctx, org.id, principalId);
  if (!org || org.state === "deleted" || !membership) {
    return c.json({ error: "not_found" }, 404);
  }
  if (membership.role !== "owner") {
    return c.json({ error: "owner_required" }, 403);
  }
  const parsed = UpdateOrganizationRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json(
      { error: "validation_error", details: parsed.error.flatten() },
      400,
    );
  }

  const ssoIssuer =
    parsed.data.ssoIssuer === undefined
      ? org.ssoIssuer
      : (parsed.data.ssoIssuer ?? undefined);
  const samlIssuer =
    parsed.data.samlIssuer === undefined
      ? org.samlIssuer
      : (parsed.data.samlIssuer ?? undefined);
  const updated: Organization = {
    id: org.id,
    slug: org.slug,
    displayName: parsed.data.displayName ?? org.displayName,
    state: org.state,
    createdBy: org.createdBy,
    createdAt: org.createdAt,
    updatedAt: ctx.clock(),
  };
  if (ssoIssuer) updated.ssoIssuer = ssoIssuer;
  if (samlIssuer) updated.samlIssuer = samlIssuer;
  ctx.stores.organizations.set(org.id, updated);
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "organization.updated",
    outcome: "succeeded",
    principalId,
    organizationId: org.id,
    correlationId: c.get("correlationId"),
    metadata: { action: "organization.update" },
  });
  return c.json(toResponse(updated, membership.role));
});

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
