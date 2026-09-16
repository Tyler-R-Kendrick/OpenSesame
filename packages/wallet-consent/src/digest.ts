/**
 * Digest over the executable terms of a wallet payment approval (CONSENT).
 *
 * Narrower than Identity-plane `canonicalRequestDigest`: that binds the whole
 * interaction envelope. This binds only what an executor must not alter —
 * currency, amount, recipient — so a lease or agent can recompute and compare
 * without needing ceremony handles.
 *
 * Length-prefixed fields (same discipline as os-domain request digests) stop
 * text from migrating across field boundaries without changing the digest.
 */

import { createHash } from "node:crypto";

/** Canonicalization version; bump when covered fields change. */
export const PAYMENT_APPROVAL_DIGEST_VERSION = 1 as const;

const PURPOSE = `opensesame:wallet-payment-approval:v${PAYMENT_APPROVAL_DIGEST_VERSION}`;

/**
 * Executable payment terms an approval authorizes.
 *
 * Amount is a decimal **string**, never a float: binary rounding would make
 * displayed and hashed values disagree (same rule as ADR 0086 / contracts).
 */
export interface PaymentApprovalIntent {
  /** ISO 4217 alphabetic code, uppercase. */
  currency: string;
  /** Bounded decimal string (e.g. `"42.00"`). */
  amount: string;
  /** Payee / recipient the human read and the executor must pay. */
  recipient: string;
}

function field(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update("\0");
  hash.update(value, "utf8");
}

/**
 * Hex digest (64 lowercase hex chars) over canonical executable terms.
 *
 * Unkeyed: an independent executor must recompute from the intent it is about
 * to run. Integrity comes from comparison against a stored expected digest.
 */
export function buildPaymentApprovalDigest(
  intent: PaymentApprovalIntent,
): string {
  const hash = createHash("sha256");
  field(hash, PURPOSE);
  field(hash, intent.currency);
  field(hash, intent.amount);
  field(hash, intent.recipient);
  return hash.digest("hex");
}
