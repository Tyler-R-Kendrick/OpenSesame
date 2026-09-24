import { appendAuditEvent } from "@opensesame/audit";
import type { OAuthClientRecord } from "@opensesame/oauth-provider";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { requireOperatorToken } from "../middleware/admin-auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

/**
 * Deployment-admin lifecycle for origin-profile clients (ADR 0050 R-B).
 * Unlike the owner-fenced registration API these routes act on clients the
 * caller does not own; they are gated on the server-only operator token, and
 * every transition is durable (store `update`) and chained-audited. The
 * branch-era in-memory overlay is explicitly rejected.
 */
export const originClientAdminRoutes = new Hono<{ Variables: Variables }>();

function toAdminResponse(client: OAuthClientRecord) {
  return {
    id: client.id,
    admissionMode: client.admissionMode,
    displayName: client.displayName,
    origin: client.origin ?? null,
    ownershipStatus: client.ownershipStatus ?? "unclaimed",
    ownerPrincipalId: client.ownerPrincipalId ?? null,
    state: client.state,
    claimedAt: client.claimedAt?.toISOString() ?? null,
    firstSeenAt: client.firstSeenAt?.toISOString() ?? null,
    lastUsedAt: client.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * Only origin-profile clients are admin-actionable here. Unknown ids and
 * pre_registered clients both answer 404: the operator console is not an
 * existence oracle for clients outside its remit (its owners already have
 * suspend/revoke via `/v1/oauth/clients/:id`).
 */
async function loadOriginClient(ctx: AppContext, id: string) {
  const client = await ctx.stores.oauthClients.findById(id);
  if (!client || client.admissionMode !== "origin_profile") return null;
  return client;
}

async function transition(
  c: Context<{ Variables: Variables }>,
  action: "suspend" | "revoke",
) {
  const ctx = c.get("ctx");
  const client = await loadOriginClient(ctx, c.req.param("id") ?? "");
  if (!client) {
    return c.json(
      { error: "not_found", message: "Origin client not found" },
      404,
    );
  }
  const target = action === "suspend" ? "suspended" : "revoked";
  if (client.state === target) {
    // Repeat of an applied transition: durable state already reflects it.
    return c.json(toAdminResponse(client));
  }
  if (client.state === "revoked") {
    return c.json(
      {
        error: "invalid_state",
        message: `Client ${client.id} is revoked and cannot transition`,
      },
      409,
    );
  }
  const now = ctx.clock();
  const updated = await ctx.stores.oauthClients.update({
    ...client,
    state: target,
    updatedAt: now,
  });
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType:
      action === "suspend" ? "oauth_client.suspended" : "oauth_client.revoked",
    outcome: "succeeded",
    actorType: "system",
    actorId: "operator",
    clientId: updated.id,
    correlationId: c.get("correlationId"),
    metadata: {
      action: `oauth_client.admin_${action}`,
      admissionMode: updated.admissionMode,
      previousState: client.state,
    },
  });
  return c.json(toAdminResponse(updated));
}

originClientAdminRoutes.post(
  "/:id/suspend",
  requireOperatorToken(),
  idempotencyMiddleware("admin.origin-client.suspend"),
  async (c) => transition(c, "suspend"),
);

originClientAdminRoutes.post(
  "/:id/revoke",
  requireOperatorToken(),
  idempotencyMiddleware("admin.origin-client.revoke"),
  async (c) => transition(c, "revoke"),
);
