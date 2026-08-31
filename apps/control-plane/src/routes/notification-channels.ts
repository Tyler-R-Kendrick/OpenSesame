import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import {
  BeginChannelBindingResponseSchema,
  BeginChannelBindingSchema,
  ChannelBindingResponseSchema,
  ChannelCapabilitiesResponseSchema,
  CompleteChannelBindingSchema,
  EffectiveRouteResponseSchema,
  NotificationPreferencesResponseSchema,
  PushPublicKeyResponseSchema,
  PushSubscriptionResponseSchema,
  RegisterPushSubscriptionSchema,
  UpdateNotificationPreferencesSchema,
} from "@opensesame/contracts";
import {
  CHANNEL_CAPABILITIES,
  DEFAULT_NOTIFICATION_PREFERENCE,
  type ExternalChannelBinding,
  NOTIFICATION_CHANNEL_KINDS,
  type NotificationClass,
  type NotificationPreferences,
  channelCapabilities,
  planNotificationRoute,
} from "@opensesame/os-domain";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { resolveApprovalPolicy } from "./approval-policy.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * Where a person is interrupted (ADR 0084).
 *
 * Two things are kept apart here, and the separation is the whole point:
 *
 * - A **binding** says a provider identity belongs to a principal. It is
 *   authority-adjacent — where an operator has opted a channel in, the bound
 *   subject is who may settle a decision from it — so creating, replacing or
 *   revoking one is security-sensitive: it needs a recent authentication and
 *   it is audited.
 * - A **preference** says where that person would like to hear about things.
 *   It can only ever narrow: `planNotificationRoute` intersects policy,
 *   preference, live bindings and configured adapters, in that order, so
 *   nothing a client PUTs here can widen what the operator allows.
 *
 * The provider *subject id* never leaves this service. It is the value a
 * forged callback would need to claim, and showing it back adds nothing a
 * person can act on — so the list response names a binding by its id and a
 * display label, and the wire contract has no field to put a subject in.
 */

/**
 * How recently the caller must have authenticated to touch a binding.
 *
 * The identity plane has no step-up ceremony of its own yet — the trust
 * broker's `TrustSession` plus a transaction-bound activation is where that
 * lands — so the strongest thing available here is the age of the session
 * that authenticated this request. It is a real check (an abandoned tab from
 * this morning cannot add a destination) and it is deliberately not called a
 * step-up: when the ceremony exists, this is the function to replace, and the
 * routes below already funnel through it.
 */
const STEP_UP_MAX_AGE_SECONDS = 900;
const BINDING_CHALLENGE_TTL_SECONDS = 900;
const BINDING_CHALLENGE_MAX_ATTEMPTS = 5;
const MAX_BINDINGS_PER_PRINCIPAL = 20;

function hasFreshAuthentication(
  ctx: AppContext,
  c: Context<{ Variables: Variables }>,
): boolean {
  const sessionId = c.get("provisionalSessionId");
  if (!sessionId) return false;
  const session = ctx.stores.provisionalSessions.get(sessionId);
  if (!session || session.revokedAt) return false;
  const age = ctx.clock().getTime() - session.createdAt.getTime();
  return age <= STEP_UP_MAX_AGE_SECONDS * 1000;
}

/** The stored form of a binding nonce. Never the nonce itself. */
function nonceDigest(
  challengeId: string,
  nonce: string,
  pepper: string,
): string {
  return `v1:${createHmac("sha256", pepper)
    .update(`opensesame:channel-binding:v1 ${challengeId} ${nonce}`)
    .digest("hex")}`;
}

function digestsMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * A destination, as its owner sees it.
 *
 * `providerSubjectId` is absent by construction rather than by remembering to
 * delete it: the schema has no such field, so a future edit that adds one to
 * the row cannot leak it here by accident.
 */
function toBindingResponse(binding: ExternalChannelBinding) {
  return ChannelBindingResponseSchema.parse({
    id: binding.id,
    kind: binding.kind,
    providerId: binding.providerId,
    ...(binding.displayLabel
      ? { displayLabel: binding.displayLabel }
      : undefined),
    state: binding.state,
    verification: binding.verification,
    createdAt: binding.createdAt.toISOString(),
    ...(binding.verifiedAt
      ? { verifiedAt: binding.verifiedAt.toISOString() }
      : undefined),
    ...(binding.revokedAt
      ? { revokedAt: binding.revokedAt.toISOString() }
      : undefined),
  });
}

/**
 * Read a proposed provider identity out of the caller's hint.
 *
 * `destinationHint` is documented as never trusted as identity, and outside
 * development it is not: `allowSelfAssertedBindings` gates whether a
 * completion may use it at all. It exists so a local stack can exercise the
 * ceremony end to end without standing up a provider, and the production
 * path waits for the provider round-trip instead.
 */
function proposedIdentity(hint: string | undefined): {
  tenantId: string;
  subjectId: string;
} | null {
  if (!hint) return null;
  const [tenantId, subjectId] = hint.includes("/")
    ? hint.split("/", 2)
    : ["", hint];
  if (!subjectId) return null;
  return { tenantId: tenantId ?? "", subjectId };
}

export const notificationChannelRoutes = new Hono<{ Variables: Variables }>();

/**
 * The capability catalogue, plus whether this deployment can actually use it.
 *
 * `configured` is separate from the capabilities on purpose. A settings
 * screen that offers Slack because Slack *could* work, on a deployment with
 * no Slack adapter, has told the person their prompts will appear somewhere
 * they will not.
 */
notificationChannelRoutes.get("/", requirePrincipal(), (c) => {
  const ctx = c.get("ctx");
  const configured = new Set(ctx.config.notifications.availableChannels);
  return c.json({
    channels: NOTIFICATION_CHANNEL_KINDS.map((kind) => {
      const caps = CHANNEL_CAPABILITIES[kind];
      return ChannelCapabilitiesResponseSchema.parse({
        kind,
        canNotify: caps.canNotify,
        canRendezvous: caps.canRendezvous,
        canReceiveAuthenticatedCallback: caps.canReceiveAuthenticatedCallback,
        canRenderDecisionActions: caps.canRenderDecisionActions,
        bindsExternalIdentity: caps.bindsExternalIdentity,
        bindsProviderTenant: caps.bindsProviderTenant,
        supportsUserVerification: caps.supportsUserVerification,
        supportsTransactionBinding: caps.supportsTransactionBinding,
        canSatisfyPhishingResistance: caps.canSatisfyPhishingResistance,
        maximumInteractionMode: caps.maximumInteractionMode,
        confidentiality: caps.confidentiality,
        // The durable inbox is not an adapter and is never unconfigured.
        configured: kind === "in_app" || configured.has(kind),
      });
    }),
  });
});

notificationChannelRoutes.get("/bindings", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const bindings =
    await ctx.repos.channelBindings.listForPrincipal(principalId);
  return c.json({ bindings: bindings.map(toBindingResponse) });
});

/** Begin a binding ceremony: the nonce is returned once and stored as a digest. */
notificationChannelRoutes.post("/bindings", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  if (!hasFreshAuthentication(ctx, c)) {
    return c.json({ error: "step_up_required" }, 403);
  }
  const parsed = BeginChannelBindingSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid_request", detail: parsed.error.message },
      400,
    );
  }
  const { kind } = parsed.data;
  const caps = channelCapabilities(kind);
  if (!caps.bindsExternalIdentity) {
    // `in_app` is the inbox itself, and a push subscription or a webhook is
    // registered by its own route: there is no external subject to bind.
    return c.json({ error: "channel_needs_no_binding" }, 422);
  }
  if (!ctx.config.notifications.availableChannels.includes(kind)) {
    return c.json({ error: "adapter_unavailable" }, 422);
  }
  const existing =
    await ctx.repos.channelBindings.listForPrincipal(principalId);
  if (existing.length >= MAX_BINDINGS_PER_PRINCIPAL) {
    return c.json({ error: "binding_limit" }, 422);
  }

  const now = ctx.clock();
  const challengeId = `chbc_${randomBytes(12).toString("base64url")}`;
  // Returned in this response and nowhere else. What is stored is the digest,
  // so a database read cannot complete somebody's binding ceremony.
  const nonce = randomBytes(24).toString("base64url");
  const proposed = proposedIdentity(parsed.data.destinationHint);
  if (proposed) {
    const taken = await ctx.repos.channelBindings.findByProviderIdentity(
      kind,
      kind,
      proposed.tenantId,
      proposed.subjectId,
    );
    // One destination, one owner. Two principals holding the same provider
    // identity would make a callback ambiguous, and the way that resolves is
    // whichever row the lookup happens to return — which is a coin toss
    // between an approver and whoever registered the collision.
    if (taken && taken.principalId !== principalId) {
      return c.json({ error: "destination_already_bound" }, 409);
    }
    if (!taken) {
      // Born `pending`, which `isBindingUsable` refuses: it holds the label
      // the person typed and can carry nothing until the ceremony completes.
      await ctx.repos.channelBindings.create({
        id: `chbd_${randomBytes(12).toString("base64url")}`,
        principalId,
        kind,
        providerId: kind,
        providerTenantId: proposed.tenantId,
        providerSubjectId: proposed.subjectId,
        ...(parsed.data.displayLabel
          ? { displayLabel: parsed.data.displayLabel }
          : undefined),
        state: "pending",
        verification: "provider_callback_challenge",
        createdAt: now,
        metadata: {},
        version: 1,
      });
    }
  }
  const expiresAt = new Date(
    now.getTime() + BINDING_CHALLENGE_TTL_SECONDS * 1000,
  );
  await ctx.repos.channelBindingChallenges.create({
    id: challengeId,
    principalId,
    kind,
    providerId: kind,
    nonceDigest: nonceDigest(challengeId, nonce, ctx.config.claimPepper),
    ...(proposed?.tenantId
      ? { expectedTenantId: proposed.tenantId }
      : undefined),
    ...(proposed?.subjectId
      ? { expectedSubjectId: proposed.subjectId }
      : undefined),
    attempts: 0,
    maxAttempts: BINDING_CHALLENGE_MAX_ATTEMPTS,
    createdAt: now,
    expiresAt,
    version: 1,
  });
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "notification.binding.began",
    principalId,
    actorType: "human",
    outcome: "succeeded",
    correlationId: c.get("correlationId"),
    metadata: { challengeId, kind },
  });
  return c.json(
    BeginChannelBindingResponseSchema.parse({
      challengeId,
      nonce,
      expiresAt: expiresAt.toISOString(),
    }),
    201,
  );
});

/**
 * Complete a binding ceremony.
 *
 * The nonce is checked against a durable attempt budget, so a caller cannot
 * grind at it, and the challenge completes exactly once — `complete` is a
 * compare-and-set, and the loser of a race is told rather than silently
 * applied.
 *
 * The identity the binding is created with comes from the challenge, never
 * from this body. Outside development the challenge only carries one once a
 * verified provider round-trip has put it there, so a caller cannot name
 * somebody else's Slack subject and have it believed.
 */
notificationChannelRoutes.post(
  "/bindings/complete",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    if (!hasFreshAuthentication(ctx, c)) {
      return c.json({ error: "step_up_required" }, 403);
    }
    const parsed = CompleteChannelBindingSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) {
      return c.json(
        { error: "invalid_request", detail: parsed.error.message },
        400,
      );
    }
    const now = ctx.clock();
    // Spending the attempt first is the point of a budget: a guess that costs
    // nothing is not fenced by a maximum.
    const challenge = await ctx.repos.channelBindingChallenges.consumeAttempt(
      parsed.data.challengeId,
      now,
    );
    if (!challenge) {
      // The store refuses to spend an attempt on a challenge that is
      // completed, lapsed or out of budget, and returns nothing to say which.
      // Re-reading it lets the person be told what actually happened without
      // the refusal itself becoming the thing that reveals it: a challenge id
      // that never existed and one belonging to somebody else both answer 404
      // below.
      const stale = await ctx.repos.channelBindingChallenges.getById(
        parsed.data.challengeId,
      );
      if (!stale || stale.principalId !== principalId) {
        return c.json({ error: "not_found" }, 404);
      }
      if (stale.completedAt) {
        return c.json({ error: "binding_already_completed" }, 409);
      }
      if (stale.expiresAt.getTime() <= now.getTime()) {
        return c.json({ error: "binding_challenge_expired" }, 410);
      }
      return c.json({ error: "too_many_attempts" }, 429);
    }
    if (challenge.principalId !== principalId) {
      return c.json({ error: "not_found" }, 404);
    }
    const presented = nonceDigest(
      challenge.id,
      parsed.data.nonce,
      ctx.config.claimPepper,
    );
    if (!digestsMatch(challenge.nonceDigest, presented)) {
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "notification.binding.denied",
        principalId,
        actorType: "human",
        outcome: "denied",
        correlationId: c.get("correlationId"),
        metadata: { challengeId: challenge.id, reason: "nonce_mismatch" },
      });
      return c.json({ error: "nonce_mismatch" }, 401);
    }
    if (!challenge.expectedSubjectId) {
      return c.json({ error: "awaiting_provider_verification" }, 409);
    }
    if (!ctx.config.notifications.allowSelfAssertedBindings) {
      // The challenge carries an identity the *caller* proposed, and this
      // deployment does not accept those. A destination decides where an
      // approval prompt appears; letting the browser asking for it also name
      // whose Slack account it is would make that a self-service claim.
      return c.json({ error: "provider_verification_required" }, 403);
    }
    const completed = await ctx.repos.channelBindingChallenges.complete(
      challenge.id,
      now,
    );
    if (!completed) return c.json({ error: "binding_already_completed" }, 409);

    // The row minted alongside the challenge, found by the identity it was
    // minted for. Flipping it to `active` keeps the label the person typed
    // and keeps one row per destination — a second row would make the
    // callback lookup a coin toss.
    const pending = await ctx.repos.channelBindings.findByProviderIdentity(
      challenge.kind,
      challenge.providerId,
      challenge.expectedTenantId ?? "",
      challenge.expectedSubjectId,
    );
    if (pending && pending.principalId !== principalId) {
      return c.json({ error: "destination_already_bound" }, 409);
    }
    const created: ExternalChannelBinding = pending
      ? await ctx.repos.channelBindings.updateWithVersion(
          pending.id,
          pending.version,
          { state: "active", verifiedAt: now },
        )
      : await ctx.repos.channelBindings.create({
          id: `chbd_${randomBytes(12).toString("base64url")}`,
          principalId,
          kind: challenge.kind,
          providerId: challenge.providerId,
          providerTenantId: challenge.expectedTenantId ?? "",
          providerSubjectId: challenge.expectedSubjectId,
          state: "active",
          verification: "operator_provisioned",
          createdAt: now,
          verifiedAt: now,
          metadata: {},
          version: 1,
        });
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "notification.binding.created",
      principalId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      targetType: "channel_binding",
      targetId: created.id,
      // The subject id is the authority-bearing half and does not belong in a
      // trail that is read by more people than can settle a request.
      metadata: {
        bindingId: created.id,
        kind: created.kind,
        providerId: created.providerId,
        verification: created.verification,
      },
    });
    return c.json(toBindingResponse(created), 201);
  },
);

/**
 * Revoke a destination.
 *
 * Fail-closed by construction: `isBindingUsable` refuses a revoked binding,
 * so a callback arriving afterwards resolves to a binding that cannot settle
 * anything, whatever the provider says about it.
 */
notificationChannelRoutes.delete(
  "/bindings/:id",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    if (!hasFreshAuthentication(ctx, c)) {
      return c.json({ error: "step_up_required" }, 403);
    }
    const id = c.req.param("id") ?? "";
    const binding = await ctx.repos.channelBindings.getById(id);
    // Someone else's binding answers 404, never 403: the id space stays
    // unenumerable, exactly as the inbox's does.
    if (!binding || binding.principalId !== principalId) {
      return c.json({ error: "not_found" }, 404);
    }
    const now = ctx.clock();
    const revoked = await ctx.repos.channelBindings.updateWithVersion(
      binding.id,
      binding.version,
      { state: "revoked", revokedAt: now },
    );
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "notification.binding.revoked",
      principalId,
      actorType: "human",
      outcome: "succeeded",
      correlationId: c.get("correlationId"),
      targetType: "channel_binding",
      targetId: binding.id,
      metadata: { bindingId: binding.id, kind: binding.kind },
    });
    return c.json(toBindingResponse(revoked));
  },
);

/* ------------------------------------------------------------------ *
 * Web Push
 * ------------------------------------------------------------------ */

notificationChannelRoutes.get("/push/key", requirePrincipal(), (c) => {
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
notificationChannelRoutes.post(
  "/push/subscriptions",
  requirePrincipal(),
  async (c) => {
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
    try {
      new URL(parsed.data.endpoint);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    const now = ctx.clock();
    const created = await ctx.repos.pushSubscriptions.create({
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
  },
);

notificationChannelRoutes.delete(
  "/push/subscriptions/:id",
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

/* ------------------------------------------------------------------ *
 * Preferences
 * ------------------------------------------------------------------ */

export const notificationPreferenceRoutes = new Hono<{
  Variables: Variables;
}>();

function toPreferencesResponse(preferences: NotificationPreferences) {
  return NotificationPreferencesResponseSchema.parse({
    byClass: preferences.byClass,
    updatedAt: preferences.updatedAt.toISOString(),
  });
}

notificationPreferenceRoutes.get("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const stored = await ctx.repos.notificationPreferences.get(principalId);
  return c.json(
    toPreferencesResponse(
      stored ?? {
        principalId,
        byClass: { authorization_request: DEFAULT_NOTIFICATION_PREFERENCE },
        updatedAt: ctx.clock(),
        version: 0,
      },
    ),
  );
});

/**
 * Record a preference.
 *
 * This write cannot widen anything, and does not try to validate that it
 * does not: it stores what the person asked for, and every read of it goes
 * through `planNotificationRoute`, which intersects it with policy, live
 * bindings and configured adapters. Enforcing at write time instead would
 * mean a preference recorded before an operator narrowed a policy stayed
 * valid afterwards — the intersection has to happen where the decision is
 * made, not where the wish is stored.
 */
notificationPreferenceRoutes.put("/", requirePrincipal(), async (c) => {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const parsed = UpdateNotificationPreferencesSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json(
      { error: "invalid_request", detail: parsed.error.message },
      400,
    );
  }
  const existing = await ctx.repos.notificationPreferences.get(principalId);
  const saved = await ctx.repos.notificationPreferences.upsert({
    principalId,
    byClass: parsed.data.byClass,
    updatedAt: ctx.clock(),
    version: (existing?.version ?? 0) + 1,
  });
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "notification.preferences.updated",
    principalId,
    actorType: "human",
    outcome: "succeeded",
    correlationId: c.get("correlationId"),
    metadata: { classes: Object.keys(parsed.data.byClass).join(",") },
  });
  return c.json(toPreferencesResponse(saved));
});

const NOTIFICATION_CLASS_VALUES: readonly NotificationClass[] = [
  "authorization_request",
  "authorization_decision",
  "security_event",
];

function requestedClass(raw: string | undefined): NotificationClass {
  const found = NOTIFICATION_CLASS_VALUES.find((cls) => cls === raw);
  return found ?? "authorization_request";
}

/**
 * The route this person's prompts will actually take, and what was dropped.
 *
 * The exclusions are the honest part. A screen that lists only the channels
 * that survived the intersection tells a person their Slack preference is
 * working when the deployment has no Slack adapter, no active binding, or a
 * policy that never allowed it.
 */
notificationPreferenceRoutes.get(
  "/effective",
  requirePrincipal(),
  async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const cls = requestedClass(c.req.query("class"));
    const stored = await ctx.repos.notificationPreferences.get(principalId);
    const preference = stored?.byClass[cls] ?? DEFAULT_NOTIFICATION_PREFERENCE;
    const bindings =
      await ctx.repos.channelBindings.listForPrincipal(principalId);
    // The baseline policy: no request in hand, so the classifier sees no
    // details and lands on the middle of the ladder rather than the lax end.
    const { policy } = resolveApprovalPolicy({
      authorizationDetails: [],
      deployment: {
        directApprovalChannels: ctx.config.notifications.directApprovalChannels,
        directDenialChannels: ctx.config.notifications.directDenialChannels,
      },
    });
    const plan = planNotificationRoute({
      policy,
      preference,
      bindings,
      availableChannels: ctx.config.notifications.availableChannels,
      now: ctx.clock(),
    });
    return c.json(
      EffectiveRouteResponseSchema.parse({
        // `bindingId` is stripped by the schema: which destination row a step
        // resolved to is this service's business, not the browser's.
        steps: plan.steps.map((step) => ({
          kind: step.kind,
          mode: step.mode,
          confidentiality: step.confidentiality,
        })),
        fanOut: plan.fanOut,
        excluded: plan.excluded,
      }),
    );
  },
);
