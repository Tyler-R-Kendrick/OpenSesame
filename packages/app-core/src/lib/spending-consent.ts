/**
 * Browser-local payment approval digest (ADR 0123 / CONSENT).
 *
 * Uses the same length-prefixed field list as `@opensesame/wallet-consent`
 * with WebCrypto so Pages never imports `node:crypto`. Caller-supplied
 * assurance labels are never accepted here.
 */

import {
  type PaymentApprovalIntent,
  paymentApprovalDigestValues,
} from "@opensesame/wallet-consent/intent";
import {
  type DigestBoundApprovalResult,
  type DigestBoundPaymentProof,
  verifyDigestBoundApproval,
} from "@opensesame/wallet-consent/verify";

export type LocalPaymentApprovalIntent = PaymentApprovalIntent;

export function localPaymentApprovalIntent(
  overrides: Partial<PaymentApprovalIntent> = {},
): PaymentApprovalIntent {
  return {
    currency: "TEST",
    amount: "25",
    recipient: "workload-research",
    assetNetwork: "eip155:31337",
    assetId: "TEST",
    maxFee: "0",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-12-31T00:00:00.000Z",
    policyVersion: "1",
    allocationRef: "child-a",
    effectiveEnforcement: "local_approval",
    ...overrides,
  };
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function fieldBytes(value: string): Uint8Array {
  const body = utf8Bytes(value);
  const len = utf8Bytes(String(body.byteLength));
  return concatBytes([len, utf8Bytes("\0"), body]);
}

function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Hex SHA-256 over canonical executable payment terms (WebCrypto). */
export async function buildLocalPaymentApprovalDigest(
  intent: LocalPaymentApprovalIntent,
): Promise<string> {
  const payload = concatBytes(
    paymentApprovalDigestValues(intent).map((value) => fieldBytes(value)),
  );
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return toHex(digest);
}

export {
  type DigestBoundApprovalRefusal,
  type DigestBoundApprovalResult,
  type DigestBoundPaymentProof,
  verifyDigestBoundApproval,
} from "@opensesame/wallet-consent/verify";

/**
 * Refuse client-written assurance/mechanism labels (WAL-B01). Digest must
 * match executable terms; verified assertion bytes are required for any
 * strong-proof claim.
 */
export async function assessLocalPaymentApproval(input: {
  readonly intent: LocalPaymentApprovalIntent;
  readonly proof: DigestBoundPaymentProof;
}): Promise<DigestBoundApprovalResult> {
  const expectedDigest = await buildLocalPaymentApprovalDigest(input.intent);
  return verifyDigestBoundApproval({
    expectedDigest,
    proof: input.proof,
  });
}
