/**
 * Self-Issued ID Token claim validity: epochs, freshness, and i_am_siop.
 */

import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import { isBoolean, isNumber } from "@opensesame/os-domain";
import { refuse } from "./errors.js";
import { MAX_EPOCH_SECONDS, MIN_EPOCH_SECONDS } from "./limits.js";

export function readEpoch(payload: JsonObject, claim: "exp" | "iat"): number {
  const value = payload[claim];
  if (!isNumber(value) || !Number.isInteger(value)) {
    refuse("malformed_id_token", "validity");
  }
  if (value < MIN_EPOCH_SECONDS || value > MAX_EPOCH_SECONDS) {
    refuse("malformed_id_token", "validity");
  }
  return value;
}

/**
 * Dynamic profiles require `i_am_siop === true`. Static profiles refuse any
 * truthy `i_am_siop` (including non-boolean truthy values that would confuse
 * a loose check).
 */
export function assertIAmSiopClaim(
  expectedIAmSiop: boolean,
  claim: JsonValue | undefined,
): void {
  if (expectedIAmSiop) {
    if (claim !== true) refuse("issuer_mismatch", "issuer_profile");
    return;
  }
  if (claim === undefined) return;
  if (!isBoolean(claim) || claim) {
    refuse("issuer_mismatch", "issuer_profile");
  }
}

export function assertTokenFreshness(input: {
  readonly exp: number;
  readonly iat: number;
  readonly now: number;
  readonly skew: number;
  readonly maxIatAge: number;
}): void {
  if (input.exp < input.now - input.skew) {
    refuse("token_expired", "validity");
  }
  if (input.iat > input.now + input.skew) {
    refuse("token_not_fresh", "validity");
  }
  if (input.iat < input.now - input.skew - input.maxIatAge) {
    refuse("token_not_fresh", "validity");
  }
}
