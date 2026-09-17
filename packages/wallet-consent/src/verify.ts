/**
 * Verify a digest-bound payment approval using WebCrypto ECDSA P-256.
 * Caller-written mechanism/assurance strings are never evidence.
 * This module is browser-safe (no node:crypto).
 */

export interface DigestBoundPaymentProof {
  boundDigest: string;
  verifiedBytes?: Uint8Array;
  publicKeySpki?: Uint8Array;
  mechanism?: string;
  assurance?: string;
}

export type DigestBoundApprovalRefusal =
  | "digest_mismatch"
  | "missing_verified_bytes"
  | "unverified_assurance"
  | "signature_invalid";

export type DigestBoundApprovalResult =
  | { ok: true; verifiedMechanism: "es256" }
  | { ok: false; reason: DigestBoundApprovalRefusal };

export interface VerifyDigestBoundApprovalInput {
  expectedDigest: string;
  proof: DigestBoundPaymentProof;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function verifyEs256(
  digestHex: string,
  signature: Uint8Array,
  publicKeySpki: Uint8Array,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      publicKeySpki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      hexToBytes(digestHex),
    );
  } catch {
    return false;
  }
}

export async function verifyDigestBoundApproval(
  input: VerifyDigestBoundApprovalInput,
): Promise<DigestBoundApprovalResult> {
  const { expectedDigest, proof } = input;
  if (proof.boundDigest !== expectedDigest) {
    return { ok: false, reason: "digest_mismatch" };
  }
  const hasBytes =
    proof.verifiedBytes !== undefined && proof.verifiedBytes.byteLength > 0;
  const hasKey =
    proof.publicKeySpki !== undefined && proof.publicKeySpki.byteLength > 0;
  if (!hasBytes || !hasKey) {
    if (proof.mechanism !== undefined || proof.assurance !== undefined) {
      return { ok: false, reason: "unverified_assurance" };
    }
    return { ok: false, reason: "missing_verified_bytes" };
  }
  const verified = await verifyEs256(
    expectedDigest,
    proof.verifiedBytes as Uint8Array,
    proof.publicKeySpki as Uint8Array,
  );
  if (!verified) {
    return { ok: false, reason: "signature_invalid" };
  }
  return { ok: true, verifiedMechanism: "es256" };
}

/** Browser-safe ephemeral P-256 signature over a digest. Test/demo only. */
export async function signDigestWithEphemeralP256(digestHex: string): Promise<{
  verifiedBytes: Uint8Array;
  publicKeySpki: Uint8Array;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      hexToBytes(digestHex),
    ),
  );
  return { verifiedBytes: sig, publicKeySpki: spki };
}
