import { appendAuditEvent } from "@opensesame/audit";
import type { ByoUpstream } from "@opensesame/os-domain";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppContext } from "../context.js";
import { requireOperatorToken } from "../middleware/admin-auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";

/**
 * Deployment-admin lifecycle for bring-your-own upstreams (D14, ADR 0055).
 *
 * BYO records are created by visitors at the login page, not by an operator,
 * so this is the one surface that can turn a registration off — an issuer
 * being abused, a DCR-minted client someone else's IdP no longer honours, a
 * record that should never have been made. Disabling is enough: the trust
 * fence (C2) resolves `active` records only, so a disabled row stops
 * authenticating anybody without being deleted, and the trail keeps saying it
 * existed.
 *
 * Like the origin-client admin routes this copies, the gate is the server-only
 * operator token — these act on records the caller does not own — and an
 * unknown id answers 404 rather than anything more informative. The list
 * deliberately omits `clientSecret`: an operator console needs to see which
 * upstreams exist, never the credential one of them holds (ADR 0005).
 */
export const BYO_ADMIN_ACTIONS = ["disable", "enable"] as const;

type ByoAdminAction = (typeof BYO_ADMIN_ACTIONS)[number];

function toAdminResponse(record: ByoUpstream) {
  return {
    id: record.id,
    issuer: record.issuer,
    label: record.label,
    clientId: record.clientId,
    clientAuth: record.clientAuth,
    registrationSource: record.registrationSource,
    state: record.state,
    createdAt: record.createdAt.toISOString(),
    lastUsedAt: record.lastUsedAt?.toISOString() ?? null,
  };
}

async function loadUpstream(
  ctx: AppContext,
  id: string,
): Promise<ByoUpstream | null> {
  if (!id) return null;
  return ctx.repos.byoUpstreams.getById(id);
}

async function transition(
  c: Context<{ Variables: Variables }>,
  action: ByoAdminAction,
): Promise<Response> {
  const ctx = c.get("ctx");
  const record = await loadUpstream(ctx, c.req.param("id") ?? "");
  if (!record) {
    return c.json(
      { error: "not_found", message: "BYO upstream not found" },
      404,
    );
  }
  const target = action === "disable" ? "disabled" : "active";
  if (record.state === target) {
    // Repeat of an applied transition: durable state already reflects it.
    return c.json(toAdminResponse(record));
  }
  const updated = await ctx.repos.byoUpstreams.setState(record.id, target);
  if (!updated) {
    return c.json(
      { error: "not_found", message: "BYO upstream not found" },
      404,
    );
  }
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType:
      action === "disable" ? "byo_upstream.disabled" : "byo_upstream.enabled",
    outcome: "succeeded",
    actorType: "system",
    actorId: "operator",
    correlationId: c.get("correlationId"),
    targetType: "byo_upstream",
    targetId: updated.id,
    metadata: {
      action: `byo_upstream.admin_${action}`,
      issuer: updated.issuer,
      fromState: record.state,
      toState: updated.state,
    },
  });
  return c.json(toAdminResponse(updated));
}

export function createByoAdminRoutes(): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();

  routes.get("/", requireOperatorToken(), async (c) => {
    const ctx = c.get("ctx");
    const upstreams = await ctx.repos.byoUpstreams.list();
    return c.json({ upstreams: upstreams.map(toAdminResponse) });
  });

  routes.post(
    "/:id/disable",
    requireOperatorToken(),
    idempotencyMiddleware("admin.byo-upstream.disable"),
    async (c) => transition(c, "disable"),
  );

  routes.post(
    "/:id/enable",
    requireOperatorToken(),
    idempotencyMiddleware("admin.byo-upstream.enable"),
    async (c) => transition(c, "enable"),
  );

  return routes;
}
