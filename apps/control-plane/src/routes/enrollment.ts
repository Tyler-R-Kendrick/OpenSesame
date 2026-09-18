import { randomBytes, randomUUID } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import type {
  Organization,
  Principal,
  ProvisionalSession,
} from "@opensesame/os-domain";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import { requireOperatorToken } from "../middleware/admin-auth.js";
import type { Variables } from "../middleware/context.js";
import {
  ENROLLMENT_TICKET_TTL_MS_DEFAULT,
  clampEnrollmentTtlMs,
  consumeEnrollmentTicket,
  storeEnrollmentTicket,
} from "../repos/enrollment-tickets.js";
import { saveProvisional } from "../repos/session-storage.js";
import { serializeKeyed } from "../serialize.js";

export const enrollmentRoutes = new Hono<{ Variables: Variables }>();

async function readJson(c: {
  req: { json: () => Promise<BoundaryValue> };
}): Promise<JsonObject> {
  const value = overlapCast(await c.req.json().catch(() => ({})));
  return isJsonObject(value) ? value : {};
}

enrollmentRoutes.post("/tickets", requireOperatorToken(), async (c) => {
  const ctx = c.get("ctx");
  const body = await readJson(c);
  const ttlMs = isNumber(body.ttlSeconds)
    ? clampEnrollmentTtlMs(body.ttlSeconds * 1000)
    : ENROLLMENT_TICKET_TTL_MS_DEFAULT;
  const minted = await storeEnrollmentTicket(
    ctx.stores.enrollmentTickets,
    ctx.clock(),
    ttlMs,
  );
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "enrollment.ticket_minted",
    outcome: "succeeded",
    correlationId: c.get("correlationId"),
    actorType: "human",
    metadata: { action: "enrollment.ticket_mint", id: minted.id },
  });
  return c.json(
    {
      id: minted.id,
      ticket: minted.ticket,
      purpose: "first_admin",
      expiresAt: minted.expiresAt.toISOString(),
    },
    201,
  );
});

enrollmentRoutes.post("/bootstrap", async (c) => {
  const ctx = c.get("ctx");
  const body = await readJson(c);
  const ticketValue = overlapCast(body.ticket);
  const ticket = isString(ticketValue) ? ticketValue.trim() : "";
  const organizationValue = overlapCast(body.organization);
  const organization = isJsonObject(organizationValue)
    ? organizationValue
    : undefined;
  const slugValue = organization ? overlapCast(organization.slug) : undefined;
  const displayNameValue = organization
    ? overlapCast(organization.displayName)
    : undefined;
  const slug = isString(slugValue) ? slugValue.trim() : "";
  const displayName = isString(displayNameValue) ? displayNameValue.trim() : "";
  if (!ticket || !slug || !displayName) {
    return c.json({ error: "invalid_request" }, 400);
  }
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || displayName.length > 128) {
    return c.json({ error: "validation_error" }, 400);
  }

  return serializeKeyed(
    ctx.stores.principalMutations,
    "enrollment-bootstrap",
    async () => {
      if (await ctx.stores.organizations.getBySlug(slug)) {
        return c.json({ error: "slug_taken" }, 409);
      }
      const consumed = await consumeEnrollmentTicket(
        ctx.stores.enrollmentTickets,
        ticket,
        ctx.clock(),
      );
      if (!consumed) {
        return c.json(
          {
            error: "unauthorized",
            message: "Enrollment ticket is invalid or spent",
          },
          401,
        );
      }
      return completeBootstrap(c, consumed.id, slug, displayName);
    },
  );
});

async function completeBootstrap(
  c: Context<{ Variables: Variables }>,
  ticketId: string,
  slug: string,
  displayName: string,
) {
  const ctx = c.get("ctx");
  const now = ctx.clock();
  const principal: Principal = {
    id: `prn_${randomUUID()}`,
    state: "active",
    assurance: "verified",
    createdAt: now,
    updatedAt: now,
    verifiedAt: now,
    version: 1,
  };
  await ctx.repos.principals.create(principal);
  const session: ProvisionalSession = {
    id: `ps_${randomUUID()}`,
    principalId: principal.id,
    quotaProfile: "verified",
    allowedActions: ["organization.create", "session.continue_anonymous"],
    createdAt: now,
    expiresAt: new Date(now.getTime() + ctx.config.provisionalTtlMs),
  };
  const accessToken = `pst_${randomBytes(24).toString("base64url")}`;
  await saveProvisional(ctx.stores, session, accessToken);
  const org: Organization = {
    id: `org:${randomUUID()}`,
    slug,
    displayName,
    state: "active",
    createdBy: principal.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.stores.organizations.set(org.id, org);
  await ctx.stores.organizationMemberships.upsert({
    organizationId: org.id,
    principalId: principal.id,
    role: "owner",
    createdAt: now,
    updatedAt: now,
  });
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "enrollment.bootstrap",
    outcome: "succeeded",
    principalId: principal.id,
    sessionId: session.id,
    correlationId: c.get("correlationId"),
    actorType: "human",
    metadata: {
      action: "enrollment.bootstrap",
      ticketId,
      organizationId: org.id,
    },
  });
  return c.json(
    {
      principalId: principal.id,
      state: principal.state,
      assurance: principal.assurance,
      sessionId: session.id,
      accessToken,
      expiresAt: session.expiresAt.toISOString(),
      tokenType: "Bearer",
      organization: { id: org.id, slug: org.slug, role: "owner" },
    },
    201,
  );
}
