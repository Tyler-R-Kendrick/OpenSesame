import { createHash, randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  PushPublicKeyResponseSchema,
  PushSubscriptionResponseSchema,
  RegisterPushSubscriptionSchema,
} from "@opensesame/contracts";
import { ConflictError, type PushSubscription } from "@opensesame/database";
import { pushSubscriptionRefusal } from "@opensesame/notification-adapters";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * Web Push enrolment (ADR 0084), mounted at `/v1/notification-channels/push`.
 * Kept apart from the binding routes: a subscription is a browser's own, not a
 * provider identity, and needs none of the binding ceremony.
 */
export const pushSubscriptionRoutes = new Hono<{ Variables: Variables }>();

pushSubscriptionRoutes.get("/key", requirePrincipal(), (c) => {
  const ctx = c.get("ctx");
  const publicKey = ctx.config.notifications.pushPublicKey;
  if (!publicKey) return c.json({ error: "adapter_unavailable" }, 404);
  return c.json(PushPublicKeyResponseSchema.parse({ publicKey }));
});

/**
 * Register a browser push subscription.
 *
 * The endpoint is a capability URL: anyone holding it can push to that
 * browser, which is why it lives in `pushSubscriptions` rather than in a
 * binding's `metadata` — that field is documented as digest-shaped and never
 * secret, and this is neither. Nothing here comes back out: the response
 * names a subscription by an opaque id and the label the person gave their
 * device, and the audit line records that a subscription exists rather than
 * how to push to it.
 *
 * The same endpoint is the same browser, so a re-subscription replaces rather
 * than accumulates — otherwise one person's phone rings twice and an operator
 * cannot say which row is live.
 */
pushSubscriptionRoutes.post("/subscriptions", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const parsed = RegisterPushSubscriptionSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid_request", detail: parsed.error.message },
      400,
    );
  }
  // The same policy delivery enforces, applied while the person can still be
  // told: HTTPS, no userinfo, no loopback, private or metadata host, and keys
  // that are what RFC 8291 encrypts to. A row failing any of it could never
  // be delivered to.
  const refusal = pushSubscriptionRefusal({
    endpoint: parsed.data.endpoint,
    keys: parsed.data.keys,
  });
  if (refusal) {
    return c.json({ error: "invalid_request", detail: refusal }, 400);
  }
  const now = ctx.clock();
  let created: PushSubscription;
  try {
    created = await ctx.repos.pushSubscriptions.create({
      id: `push_${randomBytes(12).toString("base64url")}`,
      principalId,
      endpoint: parsed.data.endpoint,
      p256dhKey: parsed.data.keys.p256dh,
      authSecret: parsed.data.keys.auth,
      // How a subscription is named and deduplicated without naming the
      // capability URL itself.
      endpointDigest: createHash("sha256")
        .update(parsed.data.endpoint)
        .digest("hex"),
      ...(parsed.data.deviceLabel
        ? { deviceLabel: parsed.data.deviceLabel }
        : undefined),
      createdAt: now,
    });
  } catch (error) {
    // An endpoint is a capability URL, and a live one stays with whoever
    // registered it. Said plainly, so the browser can drop that
    // subscription and enrol a fresh one rather than retry the same URL.
    if (error instanceof ConflictError) {
      return c.json({ error: "endpoint_already_registered" }, 409);
    }
    throw error;
  }
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "notification.push.subscribed",
    principalId,
    actorType: "human",
    outcome: "succeeded",
    correlationId: c.get("correlationId"),
    targetType: "push_subscription",
    targetId: created.id,
    metadata: { subscriptionId: created.id },
  });
  return c.json(
    PushSubscriptionResponseSchema.parse({
      id: created.id,
      ...(created.deviceLabel
        ? { deviceLabel: created.deviceLabel }
        : undefined),
      createdAt: created.createdAt.toISOString(),
    }),
    201,
  );
});

pushSubscriptionRoutes.delete(
  "/subscriptions/:id",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    const subscription = await ctx.repos.pushSubscriptions.getById(id);
    // Someone else's subscription answers 404, never 403.
    if (!subscription || subscription.principalId !== principalId) {
      return c.json({ error: "not_found" }, 404);
    }
    await ctx.repos.pushSubscriptions.disable(subscription.id, ctx.clock());
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "notification.push.unsubscribed",
      principalId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      targetType: "push_subscription",
      targetId: subscription.id,
      metadata: { subscriptionId: subscription.id },
    });
    return c.body(null, 204);
  },
);
