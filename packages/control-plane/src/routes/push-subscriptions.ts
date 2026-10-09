import { randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  PushPublicKeyResponseSchema,
  PushSubscriptionResponseSchema,
} from "@opensesame/contracts";
import { ConflictError, type PushSubscription } from "@opensesame/database";
import { Hono } from "hono";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { authenticatedPrincipalId } from "./organizations.js";
import { admit, overCap, readRegistration } from "./push-enrolment.js";

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
  const repo = ctx.repos.pushSubscriptions;
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const registration = readRegistration(await c.req.json().catch(() => ({})));
  if ("invalid" in registration) return c.json(registration.invalid, 400);
  const admission = await admit(repo, principalId, registration);
  if ("refused" in admission) return c.json({ error: admission.refused }, 409);

  const now = ctx.clock();
  let created: PushSubscription;
  try {
    created = await repo.create({
      id: `push_${randomBytes(12).toString("base64url")}`,
      principalId,
      endpoint: registration.endpoint,
      p256dhKey: registration.keys.p256dh,
      authSecret: registration.keys.auth,
      // How a subscription is named and deduplicated without naming the
      // capability URL itself.
      endpointDigest: registration.digest,
      ...(registration.deviceLabel
        ? { deviceLabel: registration.deviceLabel }
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
  if (!admission.replacing && (await overCap(repo, principalId))) {
    await repo.disable(created.id, now, principalId);
    return c.json({ error: "subscription_limit_reached" }, 409);
  }
  if (admission.legacy)
    await repo.disable(admission.legacy.id, now, principalId);
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
    const repo = ctx.repos.pushSubscriptions;
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const id = c.req.param("id") ?? "";
    // The owner is part of the write itself. Reading the owner first and
    // disabling after left a gap in which the endpoint, freed and registered
    // by someone else, could have its new row disabled by the old owner.
    const retired = await repo.disable(id, ctx.clock(), principalId);
    if (!retired) {
      // Already unsubscribed by this caller is fine and stays a 204; anyone
      // else's subscription, or none, answers 404, never 403.
      const row = await repo.getById(id);
      if (!row || row.principalId !== principalId) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.body(null, 204);
    }
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "notification.push.unsubscribed",
      principalId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      targetType: "push_subscription",
      targetId: id,
      metadata: { subscriptionId: id },
    });
    return c.body(null, 204);
  },
);
