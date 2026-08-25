import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { RegisterWebhookEndpointSchema } from "@opensesame/contracts";
import type { WebhookEndpoint } from "@opensesame/os-domain";
import { generateWebhookSecret, maskWebhookSecret } from "@opensesame/webhooks";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { idempotencyMiddleware } from "../middleware/idempotency.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * Webhook endpoint registration (ADR 0046 decision 12).
 *
 * A registered endpoint gets Standard Webhooks-signed notifications when an
 * authorization request lands in — or is settled from — the registering
 * principal's own inbox. Two rules do the security work:
 *
 * 1. An endpoint is only ever the caller's own: registered for the caller's
 *    principal, listed for it, deleted from it. Someone else's endpoint id
 *    answers 404, never 403 — the id space stays unenumerable.
 * 2. The signing secret is shown exactly once, in the registration response.
 *    Every later surface masks it, because a GET that returns usable signing
 *    keys turns a read scope into a forgery kit.
 */

const MAX_ENDPOINTS_PER_PRINCIPAL = 10;

function endpointId(): string {
  return `whep_${randomBytes(12).toString("base64url")}`;
}

export const webhookRoutes = new Hono<{ Variables: Variables }>();

webhookRoutes.post(
  "/",
  requirePrincipal(),
  idempotencyMiddleware("webhooks.register"),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const parsed = RegisterWebhookEndpointSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", detail: parsed.error.message },
        400,
      );
    }
    const existing =
      await ctx.repos.webhookEndpoints.listForPrincipal(principalId);
    if (existing.length >= MAX_ENDPOINTS_PER_PRINCIPAL) {
      return c.json({ error: "endpoint_limit" }, 422);
    }
    const endpoint: WebhookEndpoint = {
      id: endpointId(),
      principalId,
      url: parsed.data.url,
      secret: generateWebhookSecret(),
      ...(parsed.data.description
        ? { description: parsed.data.description }
        : undefined),
      createdAt: ctx.clock(),
    };
    const created = await ctx.repos.webhookEndpoints.create(endpoint);
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "webhook.endpoint_registered",
      principalId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      // The URL names the receiver, which the audit trail needs; the secret
      // never reaches audit metadata (and the redactor would drop it anyway).
      metadata: { endpointId: created.id },
    });
    return c.json(
      {
        id: created.id,
        url: created.url,
        // The one appearance of the usable secret.
        secret: created.secret,
        ...(created.description
          ? { description: created.description }
          : undefined),
        createdAt: created.createdAt.toISOString(),
      },
      201,
    );
  },
);

webhookRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const endpoints =
    await ctx.repos.webhookEndpoints.listForPrincipal(principalId);
  return c.json({
    endpoints: endpoints.map((endpoint) => ({
      id: endpoint.id,
      url: endpoint.url,
      secret: maskWebhookSecret(endpoint.secret),
      ...(endpoint.description
        ? { description: endpoint.description }
        : undefined),
      createdAt: endpoint.createdAt.toISOString(),
    })),
  });
});

webhookRoutes.delete("/:id", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const id = c.req.param("id") ?? "";
  const endpoint = await ctx.repos.webhookEndpoints.getById(id);
  if (!endpoint || endpoint.principalId !== principalId) {
    return c.json({ error: "not_found" }, 404);
  }
  await ctx.repos.webhookEndpoints.deleteById(id);
  return c.body(null, 204);
});
