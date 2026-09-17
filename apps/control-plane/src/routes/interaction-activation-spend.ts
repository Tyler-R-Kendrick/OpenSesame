/**
 * Spend a completed interaction activation and record the proof attempt.
 */

import { createHash, randomBytes } from "node:crypto";
import { ConflictError } from "@opensesame/database";
import {
  type ApprovalActivation,
  type ApprovalMechanism,
  type ApprovalProof,
  type Interaction,
  type InteractionKind,
  approvalPolicyDigest,
  approvalTransactionDigest,
  digestsEqual,
  sealApprovalProof,
} from "@opensesame/os-domain";
import {
  interactionRequiresPhishingResistance,
  mechanismPermittedForKind,
} from "@opensesame/policy";
import type { AppContext } from "../context.js";

export const INTERACTION_APPROVAL_POLICY = {
  kind: "interaction_approval",
  version: 1,
  requiredMechanism: "webauthn",
  requiredAssurance: "phishing_resistant",
} as const;

export function interactionApprovalPolicyDigest(
  kind?: InteractionKind,
): string {
  if (kind !== undefined && !interactionRequiresPhishingResistance(kind)) {
    return approvalPolicyDigest({
      kind: "interaction_approval",
      version: 1,
      requiredMechanism: "any",
      requiredAssurance: "mfa",
    });
  }
  return approvalPolicyDigest({ ...INTERACTION_APPROVAL_POLICY });
}

function mechanismForMethod(method: string | undefined): ApprovalMechanism {
  if (method === "openid4vp") return "openid4vp";
  if (method === "totp") return "out_of_band";
  return "webauthn";
}

function activationMatches(
  activation: ApprovalActivation,
  interaction: Interaction,
  principalId: string,
  decision: "approved",
  now: Date,
): boolean {
  const requestDigest = interaction.requestDigest ?? "";
  const policyDigest = interactionApprovalPolicyDigest(interaction.kind);
  const expected = approvalTransactionDigest({
    authReqId: interaction.id,
    requestDigest,
    approverPrincipalId: principalId,
    decision,
    policyDigest,
    channelKind: "in_app",
  });
  return (
    activation.decision === decision &&
    digestsEqual(activation.transactionDigest, expected) &&
    digestsEqual(activation.policyDigest, policyDigest) &&
    activation.state === "activated" &&
    activation.expiresAt.getTime() > now.getTime()
  );
}

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
  if (!activationMatches(activation, interaction, principalId, decision, now)) {
    return { ok: false, error: "proof_required" };
  }

  const mechanism = mechanismForMethod(activation.method);
  const permitted = mechanismPermittedForKind(mechanism, interaction.kind);
  const proofInputDigest = createHash("sha256").update(activationId).digest();
  if (permitted.effect !== "satisfied") {
    try {
      await ctx.repos.interactionProofAttempts.record({
        id: `ipa_${randomBytes(12).toString("base64url")}`,
        interactionId: interaction.id,
        mechanism,
        outcome: "rejected_assurance",
        proofInputDigest,
        boundDigest: requestDigest,
        expectedDigest: requestDigest,
        approverPrincipalId: principalId,
        createdAt: now,
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
    }
    return { ok: false, error: "proof_required" };
  }

  const consumed = await ctx.repos.approvalActivations.consume(
    activation.id,
    now,
  );
  if (!consumed) return { ok: false, error: "proof_required" };
  const proof: ApprovalProof = sealApprovalProof({
    mechanism,
    boundDigest: requestDigest,
    assurance: mechanism === "webauthn" ? "phishing_resistant" : "mfa",
    verifiedAt: consumed.activatedAt ?? now,
    ...(consumed.trustSessionId
      ? { credentialRef: consumed.trustSessionId }
      : undefined),
  });
  try {
    await ctx.repos.interactionProofAttempts.record({
      id: `ipa_${randomBytes(12).toString("base64url")}`,
      interactionId: interaction.id,
      mechanism,
      outcome: "accepted",
      proofInputDigest,
      boundDigest: requestDigest,
      expectedDigest: requestDigest,
      assurance: proof.assurance,
      approverPrincipalId: principalId,
      createdAt: now,
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    return { ok: false, error: "proof_required" };
  }
  return { ok: true, proof, activation: consumed };
}
