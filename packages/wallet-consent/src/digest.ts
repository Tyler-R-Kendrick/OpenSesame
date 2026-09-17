/**
 * Digest over the executable terms of a wallet payment approval (CONSENT).
 *
 * Length-prefixed fields (same discipline as os-domain request digests) stop
 * text from migrating across field boundaries without changing the digest.
 */

import { createHash } from "node:crypto";
import {
  type PaymentApprovalIntent,
  paymentApprovalDigestValues,
} from "./intent.js";

export {
  PAYMENT_APPROVAL_DIGEST_FIELD_ORDER,
  PAYMENT_APPROVAL_DIGEST_PURPOSE,
  PAYMENT_APPROVAL_DIGEST_VERSION,
  type PaymentApprovalDigestField,
  type PaymentApprovalIntent,
  paymentApprovalDigestValues,
} from "./intent.js";

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
  for (const value of paymentApprovalDigestValues(intent)) {
    field(hash, value);
  }
  return hash.digest("hex");
}
