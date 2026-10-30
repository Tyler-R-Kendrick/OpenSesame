/**
 * Interaction-scoped TOTP activation (ADR 0125). High-risk kinds refuse TOTP.
 */

import { appendAuditEvent } from "@opensesame/audit";
import {
  type ApprovalActivation,
  type Interaction,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { interactionRequiresPhishingResistance } from "@opensesame/policy";
import type { Context, Hono } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { incrementSecurityCounter } from "../repos/durable-map.js";
import { spendTotpCode } from "./mfa-totp.js";
import { authenticatedPrincipalId } from "./organizations.js";

/**
 * A six-digit code is brute-forceable when the fence is per-activation: mint a
 * new activation and the old counter no longer applies. Count attempts per
 * principal and across this process as a bounded load backstop. The actual
 * account lock is the durable `mfaFailures` counter shared with every other
 * TOTP verifier; changing activation, replica, or route buys no new guesses.
 */
const TOTP_WINDOW_MS = 10 * 60_000;
const TOTP_PER_PRINCIPAL = 10;
const TOTP_GLOBAL = 200;
const TOTP_MAX_KEYS = 2_048;
const TOTP_GLOBAL_KEY = "__global__";
const totpAttempts = new Map<string, number[]>();

/** Test hook: the budget is process-global and must not leak between suites. */
export function resetInteractionTotpBudget(): void {
  totpAttempts.clear();
}

function consumeTotpAttempt(principalId: string, now: number): boolean {
  for (const [key, times] of totpAttempts) {
    const live = times.filter((at) => now - at < TOTP_WINDOW_MS);
    if (live.length === 0) totpAttempts.delete(key);
    else if (live.length !== times.length) totpAttempts.set(key, live);
  }
  const global = totpAttempts.get(TOTP_GLOBAL_KEY) ?? [];
  const key = `principal:${principalId}`;
  const mine = totpAttempts.get(key) ?? [];
  if (global.length >= TOTP_GLOBAL || mine.length >= TOTP_PER_PRINCIPAL) {
    return false;
  }
  global.push(now);
  mine.push(now);
  totpAttempts.set(TOTP_GLOBAL_KEY, global);
  totpAttempts.set(key, mine);
  while (totpAttempts.size > TOTP_MAX_KEYS) {
    const victim = [...totpAttempts.keys()].find(
      (candidate) => candidate !== TOTP_GLOBAL_KEY,
    );
    if (victim === undefined) break;
    totpAttempts.delete(victim);
  }
  return true;
}

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

function isHttpResponse(
  value: ApprovalActivation | Response,
): value is Response {
  return value instanceof Response;
}

type PendingTotpLookup = {
  ctx: AppContext;
  principalId: string;
  interactionId: string;
  activationId: string;
  now: Date;
};

async function pendingTotpActivation(
  c: Context<{ Variables: Variables }>,
  input: PendingTotpLookup,
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
  const parsedBody = overlapCast(await c.req.json().catch(() => ({})));
  if (
    !isJsonObject(parsedBody) ||
    !isString(parsedBody.activationId) ||
    !isString(parsedBody.code) ||
    !TOTP_CODE.test(parsedBody.code)
  ) {
    return deps.fail(c, "invalid_request");
  }
  const activationId = parsedBody.activationId;
  const code = parsedBody.code;
  const activation = await pendingTotpActivation(c, {
    ctx,
    principalId,
    interactionId: row.id,
    activationId,
    now,
  });
  if (isHttpResponse(activation)) return activation;
  const secret = await ctx.stores.totpSecrets.get(principalId);
  if (!secret) return c.json({ error: "not_enrolled" }, 404);
  const nowMs = now.getTime();
  if (!consumeTotpAttempt(principalId, nowMs)) {
    return c.json({ error: "too_many_attempts" }, 429);
  }
  const fenceKey = `activation:${principalId}:${activation.id}`;
  const prior = (totpAttempts.get(fenceKey) ?? []).length;
  if (prior >= MAX_INTERACTION_TOTP_FAILURES) {
    return c.json({ error: "too_many_attempts" }, 429);
  }
  const priorTimes = totpAttempts.get(fenceKey) ?? [];
  priorTimes.push(nowMs);
  totpAttempts.set(fenceKey, priorTimes);
  const accountFenceKey = `totp:${principalId}`;
  if (
    (await incrementSecurityCounter(ctx.stores.mfaFailures, accountFenceKey)) >
    MAX_INTERACTION_TOTP_FAILURES
  ) {
    return c.json({ error: "too_many_attempts" }, 429);
  }
  // The step ledger `/v1/mfa/totp/verify` and factor removal share: a code
  // accepted anywhere is accepted once.
  const spent = await spendTotpCode(
    ctx.stores.totpSteps,
    principalId,
    secret,
    code,
  );
  if (spent !== "accepted") {
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
  await ctx.stores.mfaFailures.delete(accountFenceKey);
  totpAttempts.delete(fenceKey);
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
