/**
 * An Identity-account authenticator, as its owner may see it (ADR 0140 D10).
 *
 * The account's factors are the second steps the Identity API asks of the
 * person who is signed in — a passkey registered on the account, an
 * authenticator app's seed — not the keys that open a vault on a device
 * (ADR 0091 keeps those two ledgers apart). This record carries what tells
 * one factor from another and nothing that verifies one: never a public key,
 * a seed, a signature counter or the raw credential id. A factor's `id` is an
 * opaque handle its owner may pass back to remove it, and nothing else.
 *
 * Pure: the Identity API builds it, Pages parses it, one definition for both.
 */

import { type BoundaryValue, isJsonObject, isString } from "./json.js";

export const ACCOUNT_FACTOR_KINDS = ["passkey", "totp"] as const;
export type AccountFactorKind = (typeof ACCOUNT_FACTOR_KINDS)[number];

export interface AccountFactor {
  /** `totp`, or `pk_` and 32 hex digits of the credential id's SHA-256. */
  id: string;
  kind: AccountFactorKind;
  /** ISO 8601, where the service recorded it. */
  createdAt?: string;
}

export interface AccountFactorList {
  factors: AccountFactor[];
  /** Which kinds this deployment lets its owner add. */
  enrollable: AccountFactorKind[];
}

/** The one TOTP seed an account holds has a fixed handle. */
export const TOTP_FACTOR_ID = "totp";
const FACTOR_ID = /^(?:totp|pk_[0-9a-f]{32})$/;
/** Far above any real account; a list longer than this is refused whole. */
export const MAX_ACCOUNT_FACTORS = 64;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

export function isAccountFactorKind(
  value: BoundaryValue,
): value is AccountFactorKind {
  return value === "passkey" || value === "totp";
}

export function isAccountFactorId(value: BoundaryValue): value is string {
  return isString(value) && FACTOR_ID.test(value);
}

function factorOf(value: BoundaryValue): AccountFactor | null {
  if (!isJsonObject(value)) return null;
  const { id, kind, createdAt } = value;
  if (!isAccountFactorId(id) || !isAccountFactorKind(kind)) return null;
  if ((id === TOTP_FACTOR_ID) !== (kind === "totp")) return null;
  // Only the three named fields are copied: whatever else a response carries
  // never reaches a screen.
  const factor: AccountFactor = { id, kind };
  if (isString(createdAt) && ISO_INSTANT.test(createdAt)) {
    factor.createdAt = createdAt;
  }
  return factor;
}

/**
 * Read `GET /v1/mfa/factors`. A malformed entry, an unknown kind or an
 * oversized list refuses the whole response rather than drawing part of it.
 */
export function parseAccountFactorList(
  value: BoundaryValue,
): AccountFactorList | null {
  if (!isJsonObject(value)) return null;
  const { factors, enrollable } = value;
  if (!Array.isArray(factors) || factors.length > MAX_ACCOUNT_FACTORS) {
    return null;
  }
  const parsed: AccountFactor[] = [];
  for (const entry of factors) {
    const factor = factorOf(entry);
    if (!factor) return null;
    parsed.push(factor);
  }
  const kinds = Array.isArray(enrollable) ? enrollable : [];
  return {
    factors: parsed,
    enrollable: ACCOUNT_FACTOR_KINDS.filter((kind) => kinds.includes(kind)),
  };
}

/**
 * Removing a factor is authenticated at the account's own level (ADR 0146):
 * the delete carries a fresh proof from one of the owner's enrolled factors
 * — the one being removed counts — and the Identity API verifies it on that
 * request. A passkey proof is an assertion over a challenge minted for this
 * purpose, this principal and this factor; a code is the authenticator's
 * current one, accepted once.
 */
export const ACCOUNT_FACTOR_REMOVE_PURPOSE = "factor.remove";

export type AccountFactorProof =
  | { kind: "totp"; code: string }
  | {
      kind: "passkey";
      credentialId: string;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    };

/** The body of `DELETE /v1/mfa/factors/:id`. */
export interface AccountFactorRemoval {
  proof: AccountFactorProof;
}

/** The body asking `/v1/mfa/passkey/authentication-options` for a step-up. */
export interface AccountFactorStepUpRequest {
  purpose: typeof ACCOUNT_FACTOR_REMOVE_PURPOSE;
  factorId: string;
}
