/**
 * Canonical executable payment terms hashed into a payment-approval digest.
 * Keep field order stable: bump PAYMENT_APPROVAL_DIGEST_VERSION when it changes.
 */

/** Canonicalization version; bump when covered fields change. */
export const PAYMENT_APPROVAL_DIGEST_VERSION = 2 as const;

export const PAYMENT_APPROVAL_DIGEST_PURPOSE =
  `opensesame:wallet-payment-approval:v${PAYMENT_APPROVAL_DIGEST_VERSION}` as const;

/**
 * Executable payment terms an approval authorizes.
 *
 * Amount and maxFee are decimal **strings**, never floats. Allocation identity,
 * asset/network, period, policy version, and effective enforcement are part of
 * the signed terms so they cannot be swapped after consent.
 */
export interface PaymentApprovalIntent {
  /** ISO 4217 alphabetic code, uppercase. */
  currency: string;
  /** Bounded decimal string (e.g. `"42.00"`). */
  amount: string;
  /** Payee / recipient the human read and the executor must pay. */
  recipient: string;
  /** Chain or rail identity, e.g. `eip155:31337` or `fiat`. */
  assetNetwork: string;
  /** Token contract / asset id. Not a display ticker. */
  assetId: string;
  /** Maximum fee exposure as a decimal string. */
  maxFee: string;
  /** Inclusive period start (ISO-8601). */
  validFrom: string;
  /** Exclusive period end (ISO-8601). */
  validUntil: string;
  /** Policy version the approval is bound to. */
  policyVersion: string;
  /** Allocation the approval may reserve — not a second unsigned argument. */
  allocationRef: string;
  /** Effective enforcement digest or authority kind the human approved. */
  effectiveEnforcement: string;
}

export const PAYMENT_APPROVAL_DIGEST_FIELD_ORDER = [
  "currency",
  "amount",
  "recipient",
  "assetNetwork",
  "assetId",
  "maxFee",
  "validFrom",
  "validUntil",
  "policyVersion",
  "allocationRef",
  "effectiveEnforcement",
] as const;

export type PaymentApprovalDigestField =
  (typeof PAYMENT_APPROVAL_DIGEST_FIELD_ORDER)[number];

/** Length-prefixed hash inputs: purpose then every executable field. */
export function paymentApprovalDigestValues(
  intent: PaymentApprovalIntent,
): readonly string[] {
  return [
    PAYMENT_APPROVAL_DIGEST_PURPOSE,
    ...PAYMENT_APPROVAL_DIGEST_FIELD_ORDER.map((key) => intent[key]),
  ];
}
