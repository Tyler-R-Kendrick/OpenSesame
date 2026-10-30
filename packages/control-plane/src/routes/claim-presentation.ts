import { appendAuditEvent } from "@opensesame/audit";
import {
  type ClaimSession,
  parseClaimToken,
  verifyClaimToken,
  verifyUserCode,
} from "@opensesame/os-domain";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";
import { incrementSecurityCounter } from "../repos/durable-map.js";

/** Shared by code-gated presentation and authenticated completion. */
export const MAX_CLAIM_APPROVAL_ATTEMPTS = 5;
type RouteContext = Context<{ Variables: Variables }>;

/** A public drop ID and an unrelated login authorize no code guesses. */
export function validClaimCompletionBearer(
  pepper: string,
  claim: ClaimSession,
  token: string | undefined,
): boolean {
  if (token === undefined) return claim.targetManifest.kind !== "secret-drop";
  const parts = parseClaimToken(token);
  return (
    parts !== null &&
    parts.publicId === claim.id &&
    verifyClaimToken(pepper, token, claim.tokenDigest)
  );
}

async function deny(
  c: RouteContext,
  claimId: string,
  reason: "too_many_attempts" | "invalid_user_code",
): Promise<Response> {
  const ctx = c.get("ctx");
  await appendAuditEvent(ctx.repos.auditEvents, {
    eventType: "claim.presented",
    outcome: "denied",
    claimId,
    ...(c.get("principalId") !== undefined
      ? { principalId: c.get("principalId") }
      : undefined),
    correlationId: c.get("correlationId"),
    metadata: { action: "claim.present", reason },
  });
  return c.json({ error: reason }, reason === "too_many_attempts" ? 429 : 401);
}

/**
 * A drop link includes its payload key. Its separate code must authorize
 * manifest release even when a custom client omits the field. Other claim
 * ceremonies retain token-only presentation. Only a valid bearer can spend
 * this claim's durable attempt budget; a public id authorizes no guesses.
 */
export async function admitClaimPresentation(
  c: RouteContext,
  claimId: string,
  token: string,
  userCode: string | undefined,
): Promise<ClaimSession | Response> {
  const ctx = c.get("ctx");
  const claim = await ctx.claims.get(claimId);
  if (!claim) return c.json({ error: "not_found" }, 404);
  if (!verifyClaimToken(ctx.config.claimPepper, token, claim.tokenDigest)) {
    return c.json({ error: "INVALID_TOKEN" }, 401);
  }
  if (claim.targetManifest.kind !== "secret-drop" && userCode === undefined)
    return claim;
  const attempts = await incrementSecurityCounter(
    ctx.stores.claimApprovalAttempts,
    claim.id,
  );
  if (attempts > MAX_CLAIM_APPROVAL_ATTEMPTS)
    return deny(c, claim.id, "too_many_attempts");
  if (
    userCode === undefined ||
    !claim.userCodeDigest ||
    !verifyUserCode(
      ctx.config.claimPepper,
      claim.id,
      userCode,
      claim.userCodeDigest,
    )
  ) {
    return deny(c, claim.id, "invalid_user_code");
  }
  return claim;
}
