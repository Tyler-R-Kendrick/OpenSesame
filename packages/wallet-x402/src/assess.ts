/**
 * Exact-payment profile assessment.
 *
 * Refuses `upto`, Permit2, allowance paths, and implicit refill. When authority
 * is `preallocated_purse`, residual risk is always named in assumptions.
 */

import type { ConstraintEnforcement } from "@opensesame/wallet-policy";

import { matchChallenge } from "./challenge.js";
import {
  type AssessExactPaymentInput,
  type AssessRefusalCode,
  type ExactPaymentAssessment,
  PREALLOCATED_PURSE_RESIDUAL_RISK,
} from "./types.js";

function pushUnique(list: AssessRefusalCode[], code: AssessRefusalCode): void {
  if (!list.includes(code)) {
    list.push(code);
  }
}

function resourceBindingAssumption(): string {
  return "HTTP resource binding (method/origin/path/body) is local/merchant-evidence when the payment signature does not bind the resource on-chain";
}

/**
 * Assess a challenge (and optional alternatives) against an exact profile.
 * Pure: no network, no facilitator, no signing.
 */
export function assessExactPayment(
  input: AssessExactPaymentInput,
): ExactPaymentAssessment {
  const refusals: AssessRefusalCode[] = [];
  const assumptions: string[] = [resourceBindingAssumption()];
  const residualRisks: string[] = [];

  const { profile, challenge } = input;
  const alternatives = input.alternatives ?? [];

  if (profile.scheme !== "exact") {
    pushUnique(refusals, "SCHEME_UPTO_REFUSED");
  }

  if (profile.allowPermit2 !== false) {
    pushUnique(refusals, "PERMIT2_REFUSED");
  }

  if (profile.allowImplicitRefill !== false) {
    pushUnique(refusals, "IMPLICIT_REFILL_REFUSED");
  }

  if (challenge.scheme === "upto") {
    pushUnique(refusals, "SCHEME_UPTO_REFUSED");
  }

  if (challenge.extra?.permit2 === true) {
    pushUnique(refusals, "PERMIT2_REFUSED");
  }

  if (challenge.extra?.allowance === true) {
    pushUnique(refusals, "ALLOWANCE_PATH_REFUSED");
  }

  if (challenge.extra?.refill === true) {
    pushUnique(refusals, "IMPLICIT_REFILL_REFUSED");
  }

  const totalAlternatives = 1 + alternatives.length;
  if (totalAlternatives > profile.maxChallengeAlternatives) {
    pushUnique(refusals, "UNBOUNDED_CHALLENGE_ALTERNATIVES");
  }

  for (const alt of alternatives) {
    if (alt.scheme === "upto") {
      pushUnique(refusals, "SCHEME_UPTO_REFUSED");
    }
    if (alt.extra?.permit2 === true) {
      pushUnique(refusals, "PERMIT2_REFUSED");
    }
    if (alt.extra?.allowance === true) {
      pushUnique(refusals, "ALLOWANCE_PATH_REFUSED");
    }
    if (alt.extra?.refill === true) {
      pushUnique(refusals, "IMPLICIT_REFILL_REFUSED");
    }
  }

  const primaryMatch = matchChallenge(profile.approved, challenge);
  if (!primaryMatch.ok) {
    pushUnique(refusals, primaryMatch.code);
  }

  if (profile.authority.kind === "preallocated_purse") {
    assumptions.push(PREALLOCATED_PURSE_RESIDUAL_RISK);
    residualRisks.push(PREALLOCATED_PURSE_RESIDUAL_RISK);
  }

  const purseAssumptions =
    profile.authority.kind === "preallocated_purse"
      ? [PREALLOCATED_PURSE_RESIDUAL_RISK]
      : [];

  // Until a local harness can prove independent enforcement, every constraint
  // stays approval_only — never advertise enforced under blocked evidence.
  const amountConstraint: ConstraintEnforcement = {
    constraintRef: "x402.exact.amount",
    kind: "amount",
    requestedDigest: `amount:${profile.approved.amount}`,
    effectiveDigest: `amount:${profile.approved.amount}`,
    result: "approval_only",
    assumptions: purseAssumptions,
    evidenceRefs: [],
    authority: profile.authority,
  };

  const recipientConstraint: ConstraintEnforcement = {
    constraintRef: "x402.exact.recipient",
    kind: "recipient",
    requestedDigest: `recipient:${profile.approved.recipient}`,
    effectiveDigest: `recipient:${profile.approved.recipient}`,
    result: "approval_only",
    assumptions:
      profile.authority.kind === "preallocated_purse"
        ? [PREALLOCATED_PURSE_RESIDUAL_RISK]
        : [
            "recipient match is broker-checked against the challenge before signing; not independently enforced until harness evidence",
          ],
    evidenceRefs: [],
    authority: profile.authority,
  };

  const assetConstraint: ConstraintEnforcement = {
    constraintRef: "x402.exact.asset",
    kind: "asset",
    requestedDigest: `asset:${profile.approved.chainId}:${profile.approved.tokenContract}`,
    effectiveDigest: `asset:${profile.approved.chainId}:${profile.approved.tokenContract}`,
    result: "approval_only",
    assumptions: purseAssumptions,
    evidenceRefs: [],
    authority: profile.authority,
  };

  const accepted = refusals.length === 0;

  return {
    profileId: "x402-exact",
    accepted,
    // Local execution stays blocked until a real merchant/facilitator harness exists.
    evidenceStatus: "blocked",
    productionEnabled: false,
    refusals,
    constraints: [amountConstraint, recipientConstraint, assetConstraint],
    assumptions,
    residualRisks,
  };
}
