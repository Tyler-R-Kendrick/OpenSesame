/**
 * P-256 ECDSA helpers for digest-bound payment approval.
 * Fixture/local keys only. Node crypto — no handwritten ECDSA.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";

export type PaymentApprovalKeyPair = {
  readonly publicKeySpki: Uint8Array;
  readonly privateKeyPkcs8: Uint8Array;
};

export function generatePaymentApprovalKeyPair(): PaymentApprovalKeyPair {
  const pair = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKeySpki: new Uint8Array(pair.publicKey),
    privateKeyPkcs8: new Uint8Array(pair.privateKey),
  };
}

export function signPaymentApprovalDigest(
  digestHex: string,
  privateKeyPkcs8: Uint8Array,
): Uint8Array {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(
    sign("sha256", Buffer.from(digestHex, "hex"), {
      key,
      dsaEncoding: "ieee-p1363",
    }),
  );
}

export function verifyPaymentApprovalSignature(
  digestHex: string,
  signature: Uint8Array,
  publicKeySpki: Uint8Array,
): boolean {
  if (signature.byteLength === 0 || publicKeySpki.byteLength === 0)
    return false;
  if (!/^[0-9a-f]{64}$/.test(digestHex)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeySpki),
      format: "der",
      type: "spki",
    });
    return verify(
      "sha256",
      Buffer.from(digestHex, "hex"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}
