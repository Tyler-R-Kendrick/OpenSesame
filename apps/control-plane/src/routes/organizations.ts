import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { appendAuditEvent } from "@opensesame/audit";
import {
  CreateOrganizationRequestSchema,
  OrganizationResponseSchema,
} from "@opensesame/contracts";
import type { Organization } from "@opensesame/os-domain";
import type { Variables } from "../middleware/context.js";
import { requirePrincipal } from "../middleware/auth.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

export const organizationRoutes = new Hono<{ Variables: Variables }>();

function toResponse(org: Organization) {
  return OrganizationResponseSchema.parse({
    id: org.id,
    slug: org.slug,
    displayName: org.displayName,
    state: org.state,
    createdBy: org.createdBy,
    createdAt: org.createdAt.toISOString(),
    updatedAt: org.updatedAt.toISOString(),
  });
}

organizationRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const orgs = [...ctx.stores.organizations.values()].filter(
    (o) => o.createdBy === principalId && o.state !== "deleted",
  );
  return c.json({ organizations: orgs.map(toResponse) });
});

organizationRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("organizations.create"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = c.get("principalId")!;
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

    const parsed = CreateOrganizationRequestSchema.safeParse(await c.req.json());
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
      id: `org_${randomUUID()}`,
      slug: parsed.data.slug,
      displayName: parsed.data.displayName,
      state: "active",
      createdBy: principalId,
      createdAt: now,
      updatedAt: now,
    };
    ctx.stores.organizations.set(org.id, org);
    ctx.stores.organizationSlugs.set(org.slug, org.id);

    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "organization.created",
      outcome: "succeeded",
      principalId,
      organizationId: org.id,
      correlationId: c.get("correlationId"),
      metadata: { action: "organization.create", slug: org.slug },
    });

    return c.json(toResponse(org), 201);
  },
);

organizationRoutes.get("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = c.get("principalId")!;
  const org = ctx.stores.organizations.get(c.req.param("id"));
  if (!org || org.state === "deleted" || org.createdBy !== principalId) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json(toResponse(org));
});
