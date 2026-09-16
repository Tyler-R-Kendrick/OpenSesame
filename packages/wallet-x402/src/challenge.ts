/**
 * Pure challenge matching for the x402 exact profile.
 * Wrong chain / token / recipient / amount / scheme fail closed before any
 * adapter prepare/execute path can mint authorization.
 */

import type {
  ChallengeMatchResult,
  ExactPaymentApproved,
  X402PaymentRequirement,
} from "./types.js";

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Compare an approved exact-payment bound to a single payment requirement.
 * Order of checks is stable for tests: scheme → chain → token → recipient → amount.
 */
export function matchChallenge(
  approved: ExactPaymentApproved,
  challenge: X402PaymentRequirement,
): ChallengeMatchResult {
  if (challenge.scheme !== "exact") {
    return {
      ok: false,
      code: "CHALLENGE_SCHEME_MISMATCH",
      expected: "exact",
      actual: challenge.scheme,
    };
  }

  if (challenge.chainId !== approved.chainId) {
    return {
      ok: false,
      code: "CHALLENGE_CHAIN_MISMATCH",
      expected: approved.chainId,
      actual: challenge.chainId,
    };
  }

  if (
    normalizeAddress(challenge.asset) !==
    normalizeAddress(approved.tokenContract)
  ) {
    return {
      ok: false,
      code: "CHALLENGE_TOKEN_MISMATCH",
      expected: approved.tokenContract,
      actual: challenge.asset,
    };
  }

  if (
    normalizeAddress(challenge.payTo) !== normalizeAddress(approved.recipient)
  ) {
    return {
      ok: false,
      code: "CHALLENGE_RECIPIENT_MISMATCH",
      expected: approved.recipient,
      actual: challenge.payTo,
    };
  }

  if (challenge.maxAmountRequired !== approved.amount) {
    return {
      ok: false,
      code: "CHALLENGE_AMOUNT_MISMATCH",
      expected: approved.amount,
      actual: challenge.maxAmountRequired,
    };
  }

  return { ok: true };
}
