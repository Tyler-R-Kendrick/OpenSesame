import { createHash, randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  PushPublicKeyResponseSchema,
  PushSubscriptionResponseSchema,
  RegisterPushSubscriptionSchema,
} from "@opensesame/contracts";
import { ConflictError, type PushSubscription } from "@opensesame/database";
import {
  normalizePushEndpoint,
  pushSubscriptionRefusal,
} from "@opensesame/notification-adapters";
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

/**
 * Live subscriptions one principal may hold. A person has a handful of
 * browsers; anything near this is somebody pointing the shared worker at
 * endpoints that never answer, and every one of them is a request the worker
 * must wait out. Registering past it answers 409 `subscription_limit_reached`;
 * replacing a subscription already held, or unsubscribing one, never counts
 * against it.
 */
export const MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL = 10;

const sha256Hex = (text: string) =>
  createHash("sha256").update(text).digest("hex");

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
  const parsed = RegisterPushSubscriptionSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid_request", detail: parsed.error.message },
      400,
    );
  }
  // One spelling per endpoint, so the digest the ownership rule keys on cannot
  // be sidestepped with a differently written copy of the same URL.
  const endpoint = normalizePushEndpoint(parsed.data.endpoint);
  if (!endpoint) {
    return c.json(
      { error: "invalid_request", detail: "insecure_endpoint" },
      400,
    );
  }
  // The same policy delivery enforces, applied while the person can still be
  // told: HTTPS, no userinfo, no loopback, private or metadata host, and keys
  // that are what RFC 8291 encrypts to. A row failing any of it could never
  // be delivered to.
  const refusal = pushSubscriptionRefusal({
    endpoint,
    keys: parsed.data.keys,
  });
  if (refusal) {
    return c.json({ error: "invalid_request", detail: refusal }, 400);
  }
  const digest = sha256Hex(endpoint);
  // Rows written before endpoints were normalized are keyed on the raw string.
  // They keep working as they are; one the presented spelling matches is still
  // somebody's, and is carried over below if it is the caller's own.
  const rawDigest = sha256Hex(parsed.data.endpoint);
  const legacy =
    rawDigest === digest ? null : await repo.findByEndpointDigest(rawDigest);
  const legacyLive = legacy && !legacy.disabledAt ? legacy : null;
  if (legacyLive && legacyLive.principalId !== principalId) {
    return c.json({ error: "endpoint_already_registered" }, 409);
  }
  const limit = (): Response =>
    c.json({ error: "subscription_limit_reached" }, 409);
  const held = await repo.listForPrincipal(principalId);
  const replacing = held.some(
    (row) => row.endpointDigest === digest || row.endpointDigest === rawDigest,
  );
  if (!replacing && held.length >= MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL) {
    return limit();
  }
  const now = ctx.clock();
  let created: PushSubscription;
  try {
    created = await repo.create({
      id: `push_${randomBytes(12).toString("base64url")}`,
      principalId,
      endpoint,
      p256dhKey: parsed.data.keys.p256dh,
      authSecret: parsed.data.keys.auth,
      // How a subscription is named and deduplicated without naming the
      // capability URL itself.
      endpointDigest: digest,
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
  // Concurrent registrations can each pass the check above. Count again, and
  // withdraw this one if the principal is now over: two racers may both back
  // out (fail closed), but the cap is never exceeded.
  if (
    !replacing &&
    (await repo.listForPrincipal(principalId)).length >
      MAX_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL
  ) {
    await repo.disable(created.id, now, principalId);
    return limit();
  }
  if (legacyLive) await repo.disable(legacyLive.id, now, principalId);
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
