/**
 * Interaction-scoped TOTP activation (ADR 0125). High-risk kinds refuse TOTP.
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  type ApprovalActivation,
  type Interaction,
  isString,
} from "@opensesame/os-domain";
import { interactionRequiresPhishingResistance } from "@opensesame/policy";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { incrementSecurityCounter } from "../repos/durable-map.js";
import { totpCode } from "./mfa.js";
import { authenticatedPrincipalId } from "./organizations.js";

const MAX_INTERACTION_TOTP_FAILURES = 5;
const TOTP_CODE = /^\d{6}$/;

type TotpActivationDeps = {
  loadByRef: (
    ctx: AppContext,
    ref: string,
    now: Date,
  ) => Promise<Interaction | null>;
  isApprover: (row: Interaction, principalId: string) => boolean;
  fail: (
    c: Context<{ Variables: Variables }>,
    name: "interaction_not_found" | "invalid_request",
  ) => Response | Promise<Response>;
};

function totpCodesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function isHttpResponse(
  value: ApprovalActivation | Response,
): value is Response {
  return value instanceof Response;
}

async function pendingTotpActivation(
  c: Context<{ Variables: Variables }>,
  input: {
    ctx: AppContext;
    principalId: string;
    interactionId: string;
    activationId: string;
    now: Date;
  },
): Promise<ApprovalActivation | Response> {
  const activation = await input.ctx.repos.approvalActivations.getById(
    input.activationId,
  );
  if (
    !activation ||
    activation.principalId !== input.principalId ||
    activation.authReqId !== input.interactionId
  ) {
    return c.json({ error: "activation_not_found" }, 404);
  }
  if (activation.expiresAt.getTime() <= input.now.getTime()) {
    return c.json({ error: "activation_expired" }, 410);
  }
  if (activation.state !== "pending" || activation.method !== "totp") {
    return c.json({ error: "activation_not_pending" }, 409);
  }
  return activation;
}

async function completeTotp(
  c: Context<{ Variables: Variables }>,
  deps: TotpActivationDeps,
): Promise<Response> {
  const ctx = c.get("ctx");
  const principalId = authenticatedPrincipalId(c.get("principalId"));
  const now = ctx.clock();
  const row = await deps.loadByRef(ctx, c.req.param("ref") ?? "", now);
  if (!row || !deps.isApprover(row, principalId)) {
    return deps.fail(c, "interaction_not_found");
  }
  if (interactionRequiresPhishingResistance(row.kind)) {
    return deps.fail(c, "invalid_request");
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    activationId?: unknown;
    code?: unknown;
  };
  if (
    !isString(body.activationId) ||
    !isString(body.code) ||
    !TOTP_CODE.test(body.code)
  ) {
    return deps.fail(c, "invalid_request");
  }
  const activation = await pendingTotpActivation(c, {
    ctx,
    principalId,
    interactionId: row.id,
    activationId: body.activationId,
    now,
  });
  if (isHttpResponse(activation)) return activation;
  const secret = await ctx.stores.totpSecrets.get(principalId);
  if (!secret) return c.json({ error: "not_enrolled" }, 404);
  const fenceKey = `interaction-totp:${principalId}:${activation.id}`;
  const prior =
    (await incrementSecurityCounter(ctx.stores.mfaFailures, fenceKey)) - 1;
  if (prior >= MAX_INTERACTION_TOTP_FAILURES) {
    return c.json({ error: "too_many_attempts" }, 429);
  }
  if (!totpCodesEqual(body.code, totpCode(secret))) {
    await appendAuditEvent(ctx.repos.auditEvents, {
      eventType: "authority.activation.denied",
      principalId,
      actorType: "human",
      outcome: "denied",
      correlationId: c.get("correlationId"),
      metadata: {
        authReqId: row.id,
        activationId: activation.id,
        reason: "totp_failed",
      },
    });
    return c.json({ error: "activation_verification_failed" }, 401);
  }
  await ctx.stores.mfaFailures.delete(fenceKey);
  const updated: ApprovalActivation =
    await ctx.repos.approvalActivations.updateWithVersion(
      activation.id,
      activation.version,
      { state: "activated", activatedAt: now, method: "totp" },
    );
  return c.json({
    activationId: updated.id,
    state: updated.state,
    activatedAt: updated.activatedAt?.toISOString() ?? now.toISOString(),
  });
}

export function attachInteractionTotpRoute(
  routes: Hono<{ Variables: Variables }>,
  deps: TotpActivationDeps,
): void {
  routes.post("/:ref/activation/totp", requirePrincipal(), (c) =>
    completeTotp(c, deps),
  );
}
