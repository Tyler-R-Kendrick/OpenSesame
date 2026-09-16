/**
 * Interaction-scoped approval activations (ADR 0086 / F01).
 *
 * Mirrors authorization-request activations: mint a WebAuthn challenge bound
 * to the interaction + decision, verify the raw assertion, then let
 * `decideRoute("approved")` spend the activated row. An ordinary session may
 * deny (authority only shrinks) but cannot approve.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendAuditEvent } from "@opensesame/audit";
import { issueTransactionChallenge } from "@opensesame/auth-upstream";
import {
  BeginApprovalActivationResponseSchema,
  BeginApprovalActivationSchema,
  CompleteApprovalActivationSchema,
} from "@opensesame/contracts";
import {
  type ApprovalActivation,
  type ApprovalProof,
  type Interaction,
  approvalPolicyDigest,
  approvalTransactionDigest,
  digestsEqual,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import type { Hono } from "hono";
import type { Context } from "hono";
import type { AppContext } from "../context.js";
import { requirePrincipal } from "../middleware/auth.js";
import type { Variables } from "../middleware/context.js";
import { webAuthnRpFromPublicUrl } from "./approval-ceremony.js";
import { authenticatedPrincipalId } from "./organizations.js";

const MAX_ACTIVATION_TTL_SECONDS = 5 * 60;
const MAX_ASSERTION_FIELD_LENGTH = 8_192;

/** Fixed policy for interaction step-up until per-kind policy lands (D-03). */
export const INTERACTION_APPROVAL_POLICY = {
  kind: "interaction_approval",
  version: 1,
  requiredMechanism: "webauthn",
  requiredAssurance: "phishing_resistant",
} as const;

export function interactionApprovalPolicyDigest(): string {
  return approvalPolicyDigest({ ...INTERACTION_APPROVAL_POLICY });
}

function challengeDigest(challenge: string): string {
  return `v1:${createHash("sha256")
    .update(`opensesame:activation-challenge:v1\0${challenge}`)
    .digest("hex")}`;
}

function challengeFromClientData(clientDataJSON: string): string | null {
  try {
    const parsed: { challenge?: string } = overlapCast(
      JSON.parse(Buffer.from(clientDataJSON, "base64").toString("utf8")),
    );
    const challenge = parsed.challenge;
    return challenge && isString(challenge) ? challenge : null;
  } catch {
    return null;
  }
}

export type InteractionActivationDeps = {
  loadByRef: (
    ctx: AppContext,
    ref: string,
    now: Date,
  ) => Promise<Interaction | null>;
  isApprover: (row: Interaction, principalId: string) => boolean;
  fail: (
    c: Context<{ Variables: Variables }>,
    name:
      | "interaction_not_found"
      | "interaction_expired"
      | "interaction_settled"
      | "digest_mismatch"
      | "proof_required"
      | "invalid_request",
  ) => Response | Promise<Response>;
};

/**
 * Spend a completed activation for an interaction approval.
 * Returns the server-built proof, or a refusal code.
 */
export async function spendInteractionActivation(input: {
  ctx: AppContext;
  interaction: Interaction;
  principalId: string;
  activationId: string;
  decision: "approved";
  now: Date;
}): Promise<
  | { ok: true; proof: ApprovalProof; activation: ApprovalActivation }
  | { ok: false; error: "proof_required" | "digest_mismatch" }
> {
  const { ctx, interaction, principalId, activationId, decision, now } = input;
  const activation = await ctx.repos.approvalActivations.getById(activationId);
  if (
    !activation ||
    activation.principalId !== principalId ||
    activation.authReqId !== interaction.id
  ) {
    return { ok: false, error: "proof_required" };
  }

  const requestDigest = interaction.requestDigest ?? "";
  const policyDigest = interactionApprovalPolicyDigest();
  const expectedTransactionDigest = approvalTransactionDigest({
    authReqId: interaction.id,
    requestDigest,
    approverPrincipalId: principalId,
    decision,
    policyDigest,
    channelKind: "in_app",
  });

  if (
    activation.decision !== decision ||
    !digestsEqual(activation.transactionDigest, expectedTransactionDigest) ||
    !digestsEqual(activation.policyDigest, policyDigest) ||
    activation.state !== "activated" ||
    activation.expiresAt.getTime() <= now.getTime()
  ) {
    return { ok: false, error: "proof_required" };
  }

  const consumed = await ctx.repos.approvalActivations.consume(
    activation.id,
    now,
  );
  if (!consumed) return { ok: false, error: "proof_required" };
  const proof: ApprovalProof = {
    mechanism: consumed.method === "openid4vp" ? "openid4vp" : "webauthn",
    boundDigest: requestDigest,
    // OID4VP proves possession of a credential under the verifier profile;
    // it is not automatically a phishing-resistant platform authenticator.
    assurance: consumed.method === "openid4vp" ? "mfa" : "phishing_resistant",
    verifiedAt: consumed.activatedAt ?? now,
  };
  if (consumed.trustSessionId) {
    proof.credentialRef = consumed.trustSessionId;
  }
  return { ok: true, proof, activation: consumed };
}

export function attachInteractionActivationRoutes(
  routes: Hono<{ Variables: Variables }>,
  deps: InteractionActivationDeps,
): void {
  routes.post("/:ref/activation", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const now = ctx.clock();
    const row = await deps.loadByRef(ctx, c.req.param("ref") ?? "", now);
    if (!row || !deps.isApprover(row, principalId)) {
      return deps.fail(c, "interaction_not_found");
    }
    if (row.status === "expired") return deps.fail(c, "interaction_expired");
    if (
      row.status === "approved" ||
      row.status === "denied" ||
      row.status === "consumed" ||
      row.status === "revoked"
    ) {
      return deps.fail(c, "interaction_settled");
    }

    const parsed = BeginApprovalActivationSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return deps.fail(c, "invalid_request");
    if (parsed.data.decision !== "approved") {
      // Deny does not need an activation; refuse to mint one for deny so a
      // deny-bound activation cannot be spent as approve.
      return deps.fail(c, "invalid_request");
    }
    if (
      row.requestDigest === undefined ||
      !digestsEqual(row.requestDigest, parsed.data.requestDigest)
    ) {
      return deps.fail(c, "digest_mismatch");
    }

    const policyDigest = interactionApprovalPolicyDigest();
    const transactionDigest = approvalTransactionDigest({
      authReqId: row.id,
      requestDigest: row.requestDigest,
      approverPrincipalId: principalId,
      decision: "approved",
      policyDigest,
      channelKind: "in_app",
    });
    const rp = webAuthnRpFromPublicUrl(ctx.config.publicUrl);
    const ttlSeconds = MAX_ACTIVATION_TTL_SECONDS;
    const { challenge, options } = await issueTransactionChallenge(
      ctx.passkeyChallenges,
      rp,
      { principalId, transactionDigest, ttlMs: ttlSeconds * 1000 },
    );
    const activation: ApprovalActivation = {
      id: `apac_${randomBytes(12).toString("base64url")}`,
      authReqId: row.id,
      principalId,
      transactionDigest,
      decision: "approved",
      policyDigest,
      channelKind: "in_app",
      challengeDigest: challengeDigest(challenge),
      state: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      version: 1,
    };
    await ctx.repos.approvalActivations.create(activation);
    return c.json(
      BeginApprovalActivationResponseSchema.parse({
        activationId: activation.id,
        transactionDigest,
        policyDigest,
        expiresAt: activation.expiresAt.toISOString(),
        options,
      }),
      201,
    );
  });

  routes.post("/:ref/activation/complete", requirePrincipal(), async (c) => {
    const ctx = c.get("ctx");
    const principalId = authenticatedPrincipalId(c.get("principalId"));
    const ref = c.req.param("ref") ?? "";
    const now = ctx.clock();
    const row = await deps.loadByRef(ctx, ref, now);
    if (!row || !deps.isApprover(row, principalId)) {
      return deps.fail(c, "interaction_not_found");
    }

    const parsed = CompleteApprovalActivationSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!parsed.success) return deps.fail(c, "invalid_request");
    const body = parsed.data;
    if (
      [
        body.credentialId,
        body.clientDataJSON,
        body.authenticatorData,
        body.signature,
      ].some((value) => value.length > MAX_ASSERTION_FIELD_LENGTH)
    ) {
      return deps.fail(c, "invalid_request");
    }

    const activation = await ctx.repos.approvalActivations.getById(
      body.activationId,
    );
    if (
      !activation ||
      activation.principalId !== principalId ||
      activation.authReqId !== row.id
    ) {
      return c.json({ error: "activation_not_found" }, 404);
    }
    if (activation.expiresAt.getTime() <= now.getTime()) {
      return c.json({ error: "activation_expired" }, 410);
    }
    if (activation.state !== "pending") {
      return c.json({ error: "activation_not_pending" }, 409);
    }

    const challenge = challengeFromClientData(body.clientDataJSON);
    if (
      !challenge ||
      !digestsEqual(challengeDigest(challenge), activation.challengeDigest)
    ) {
      return c.json({ error: "activation_challenge_mismatch" }, 401);
    }

    const issued = await ctx.passkeyChallenges.peek(challenge);
    if (
      issued &&
      (issued.purpose !== "transaction" ||
        issued.principalId !== principalId ||
        !issued.transactionDigest ||
        !digestsEqual(issued.transactionDigest, activation.transactionDigest))
    ) {
      return c.json({ error: "activation_challenge_mismatch" }, 401);
    }

    // Always the real verifier, never the dev-defaulted `ctx.passkeys` seam:
    // an interaction approval is an authorization-assurance decision (ADR
    // 0084 phishing resistance), so it must be a genuine cryptographic check
    // even where dev defaults are enabled. This is the same seam
    // `host-authorization.ts` uses for the identical reason.
    const verified = await ctx.hostAuthorizationPasskeys.verify({
      credentialId: body.credentialId,
      clientDataJSON: Buffer.from(body.clientDataJSON, "base64"),
      authenticatorData: Buffer.from(body.authenticatorData, "base64"),
      signature: Buffer.from(body.signature, "base64"),
      expectedPurpose: "transaction",
    });
    if (!verified.ok || verified.principalId !== principalId) {
      await appendAuditEvent(ctx.repos.auditEvents, {
        eventType: "authority.activation.denied",
        principalId,
        actorType: "human",
        outcome: "denied",
        correlationId: c.get("correlationId"),
        metadata: {
          authReqId: row.id,
          activationId: activation.id,
          reason: "assertion_failed",
        },
      });
      return c.json({ error: "activation_verification_failed" }, 401);
    }

    // No `trustSessionId`, and so no `credentialRef` on the sealed proof: the
    // audit row records the mechanism the authority verified and the digest it
    // bound, not the credential handle. In a discoverable-credential flow that
    // handle is the authenticator's own choice rather than a fact worth
    // repeating, and the real verifier returns no credential id to record in
    // any case (interaction-handoff asserts `credentialRef` stays absent).
    const updated = await ctx.repos.approvalActivations.updateWithVersion(
      activation.id,
      activation.version,
      { state: "activated", activatedAt: now, method: "webauthn" },
    );
    return c.json({
      activationId: updated.id,
      state: updated.state,
      activatedAt: updated.activatedAt?.toISOString() ?? now.toISOString(),
    });
  });
}
