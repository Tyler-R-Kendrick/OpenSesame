/**
 * Hosted OpenID4VP verifier surface (ADR 0086 §4, finding F08).
 *
 * Wraps `@opensesame/openid4vp`'s `beginPresentation` / `finishPresentation`
 * so a presentation can settle an interaction: the approval binding digest is
 * the interaction's `requestDigest`, and a successful verify yields an
 * activated `ApprovalActivation` the existing `/approve` path spends.
 *
 * Trusted-issuer material is injected; an empty set refuses every finish
 * closed rather than auto-trusting a credential's named issuer.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type CourierDelivery,
  InMemoryRequestSessionStore,
  Openid4vpError,
  type RequestSessionStore,
  type TrustedIssuer,
  type VerifiedPresentation,
  beginPresentation,
  finishPresentation,
} from "@opensesame/openid4vp";
import {
  type ApprovalActivation,
  type BoundaryValue,
  type Interaction,
  type JsonObject,
  approvalTransactionDigest,
  digestsEqual,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { interactionApprovalPolicyDigest } from "./interaction-activation.js";
import { authenticatedPrincipalId } from "./organizations.js";

export interface Openid4vpRouteOptions {
  readonly publicUrl: string;
  readonly clock: () => Date;
  readonly vct: string;
  readonly trustedIssuers?: readonly TrustedIssuer[];
  /** Test seam: replace the in-memory protocol session store. */
  readonly sessionStore?: RequestSessionStore;
}

interface PendingPresentation {
  readonly interactionId: string;
  readonly principalId: string;
  readonly protocolDigest: string;
  readonly approvalBindingDigest: string;
  readonly expiresAt: Date;
}

const BeginSchema = z.object({
  interactionId: z.string().min(8).max(128),
  requestDigest: z.string().min(16).max(256),
  responseMode: z.enum(["direct_post", "dc_api"]).default("direct_post"),
});

const CompleteSchema = z.object({
  state: z.string().min(8).max(256),
  responseMode: z.enum(["direct_post", "dc_api"]),
});

type FailStatus = 400 | 401 | 404 | 409;

function fail(
  c: Context<{ Variables: Variables }>,
  error: string,
  status: FailStatus = 400,
): Response {
  return c.json({ error }, status);
}

export function createOpenid4vpRoutes(
  options: Openid4vpRouteOptions,
): Hono<{ Variables: Variables }> {
  const store = options.sessionStore ?? new InMemoryRequestSessionStore();
  const trustedIssuers = options.trustedIssuers ?? [];
  const pending = new Map<string, PendingPresentation>();
  const verifierConfig = {
    store,
    trustedIssuers,
    now: options.clock,
  };

  const routes = new Hono<{ Variables: Variables }>();

  routes.get("/ping", (c) =>
    c.json({ ok: true, surface: "openid4vp.verifier" }),
  );

  routes.post("/presentations", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const parsed = BeginSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return fail(c, "invalid_request");

    const row = await loadApproverInteraction(
      ctx,
      parsed.data.interactionId,
      principalId,
    );
    if (!row) return fail(c, "interaction_not_found", 404);
    if (row.status === "expired") return fail(c, "interaction_expired", 409);
    if (
      row.requestDigest === undefined ||
      !digestsEqual(row.requestDigest, parsed.data.requestDigest)
    ) {
      return fail(c, "digest_mismatch");
    }

    const base = options.publicUrl.replace(/\/$/, "");
    const responseMode = parsed.data.responseMode;
    const responseUri = `${base}/v1/openid4vp/response`;
    const begun = await beginPresentation(verifierConfig, {
      responseMode,
      ...(responseMode === "direct_post"
        ? {
            clientId: `redirect_uri:${responseUri}`,
            responseUri,
          }
        : { origin: new URL(base).origin }),
      dcqlQuery: {
        credentials: [
          {
            id: "opensesame",
            format: "dc+sd-jwt",
            vctValues: [options.vct],
          },
        ],
      },
      // Binding transaction_data is appended by buildAuthorizationRequest;
      // callers must not invent a second opensesame_request_binding entry.
      approvalBindingDigest: row.requestDigest,
      now: options.clock(),
    });

    pending.set(begun.state, {
      interactionId: row.id,
      principalId,
      protocolDigest: begun.digests.protocol,
      approvalBindingDigest: begun.digests.approval,
      expiresAt: begun.request.expiresAt,
    });

    return c.json({
      state: begun.state,
      digests: begun.digests,
      parameters: begun.parameters,
      digitalCredentialsRequest: begun.digitalCredentialsRequest,
    });
  });

  routes.post("/presentations/complete", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const rawBoundary: BoundaryValue = overlapCast(
      await c.req.json().catch(() => ({})),
    );
    if (!isJsonObject(rawBoundary)) return fail(c, "invalid_request");
    const raw = rawBoundary;
    const parsed = CompleteSchema.safeParse({
      state: raw.state,
      responseMode: raw.responseMode,
    });
    if (!parsed.success) return fail(c, "invalid_request");
    const bodyValue = raw.body;
    if (!isJsonObject(bodyValue)) return fail(c, "invalid_request");

    const attempt = pending.get(parsed.data.state);
    if (!attempt || attempt.principalId !== principalId) {
      return fail(c, "presentation_unknown", 404);
    }
    if (attempt.expiresAt.getTime() <= options.clock().getTime()) {
      pending.delete(parsed.data.state);
      return fail(c, "presentation_expired", 409);
    }

    const row = await loadApproverInteraction(
      ctx,
      attempt.interactionId,
      principalId,
    );
    if (!row?.requestDigest) return fail(c, "interaction_not_found", 404);

    let verified: VerifiedPresentation;
    try {
      const delivery: CourierDelivery = {
        responseMode: parsed.data.responseMode,
        body: asCourierBody(bodyValue),
      };
      verified = await finishPresentation(verifierConfig, {
        delivery,
        expectedRequestDigest: attempt.protocolDigest,
      });
    } catch (error) {
      if (error instanceof Openid4vpError) {
        return c.json({ error: error.code, detail: error.checkpoint }, 400);
      }
      throw error;
    }

    if (!digestsEqual(verified.boundDigest, attempt.approvalBindingDigest)) {
      return fail(c, "digest_mismatch");
    }
    if (!digestsEqual(verified.boundDigest, row.requestDigest)) {
      return fail(c, "digest_mismatch");
    }

    const activation = await activateFromPresentation({
      ctx,
      interaction: row,
      principalId,
      now: options.clock(),
      credentialRef: verified.credentialRef,
    });
    pending.delete(parsed.data.state);
    return c.json({
      activationId: activation.id,
      boundDigest: verified.boundDigest,
      mechanism: "openid4vp",
    });
  });

  // Public direct_post callback: accepts the wallet form body, does not settle
  // the interaction by itself — the authenticated complete route still binds
  // the presentation to the approver session.
  routes.post("/response", async (c) => {
    const form = await c.req.parseBody();
    // SAFETY: parseBody values are string | File; only strings are states.
    const stateValue: BoundaryValue = overlapCast(form.state);
    const state = isString(stateValue) ? stateValue : "";
    const attempt = pending.get(state);
    if (!attempt) return fail(c, "presentation_unknown", 404);
    return c.json({
      status: "received",
      state,
      // The wallet POSTed here; the approver finishes in-app with the same
      // body so principal mapping cannot be skipped via an unauthenticated
      // callback alone.
      next: "POST /v1/openid4vp/presentations/complete",
    });
  });

  return routes;
}

async function loadApproverInteraction(
  ctx: AppContext,
  interactionId: string,
  principalId: string,
): Promise<Interaction | null> {
  const row = await ctx.repos.interactions.getById(interactionId);
  if (!row) return null;
  if (row.approverPrincipalId !== principalId) return null;
  return row;
}

interface ActivateFromPresentationInput {
  readonly ctx: AppContext;
  readonly interaction: Interaction;
  readonly principalId: string;
  readonly now: Date;
  readonly credentialRef: string;
}

async function activateFromPresentation(
  input: ActivateFromPresentationInput,
): Promise<ApprovalActivation> {
  const { ctx, interaction, principalId, now, credentialRef } = input;
  const requestDigest = interaction.requestDigest ?? "";
  const policyDigest = interactionApprovalPolicyDigest(interaction.kind);
  const transactionDigest = approvalTransactionDigest({
    authReqId: interaction.id,
    requestDigest,
    approverPrincipalId: principalId,
    decision: "approved",
    policyDigest,
    channelKind: "in_app",
  });
  const activation: ApprovalActivation = {
    id: `act_${randomUUID().replace(/-/g, "")}`,
    authReqId: interaction.id,
    principalId,
    transactionDigest,
    decision: "approved",
    policyDigest,
    channelKind: "in_app",
    challengeDigest: `sha256:${createHash("sha256").update(randomBytes(32)).digest("hex")}`,
    state: "activated",
    createdAt: now,
    activatedAt: now,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    trustSessionId: credentialRef,
    method: "openid4vp",
    version: 1,
  };
  await ctx.repos.approvalActivations.create(activation);
  return activation;
}

/** Narrow a courier body without spreading unknown bags into verification. */
function asCourierBody(value: JsonObject): JsonObject {
  const out: { [key: string]: JsonObject[string] } = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isString(entry) || isJsonObject(entry) || Array.isArray(entry)) {
      out[key] = entry;
    }
  }
  return out;
}
