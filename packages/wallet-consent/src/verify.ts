/**
 * Verify a digest-bound payment approval using WebCrypto ECDSA P-256.
 * Caller-written mechanism/assurance strings are never evidence, and neither
 * is a caller-written key: the signature is checked only against a key the
 * verifier was given as enrolled (`trustedKeys`). A proof that names a key
 * outside that set is refused before any signature check, so an approval
 * self-signed with an ephemeral key proves nothing.
 * This module is browser-safe (no node:crypto).
 */

export interface DigestBoundPaymentProof {
  boundDigest: string;
  verifiedBytes?: Uint8Array;
  /**
   * Optional hint naming which enrolled key signed. Never a trust anchor:
   * it must byte-equal one of the verifier's `trustedKeys`.
   */
  publicKeySpki?: Uint8Array;
  mechanism?: string;
  assurance?: string;
}

export type DigestBoundApprovalRefusal =
  | "digest_mismatch"
  | "missing_verified_bytes"
  | "unverified_assurance"
  | "key_not_enrolled"
  | "signature_invalid";

export type DigestBoundApprovalResult =
  | { ok: true; verifiedMechanism: "es256" }
  | { ok: false; reason: DigestBoundApprovalRefusal };

export interface VerifyDigestBoundApprovalInput {
  expectedDigest: string;
  proof: DigestBoundPaymentProof;
  /**
   * SPKI (DER) public keys enrolled as payment-approval keys, from the
   * verifier's own store — never from the request carrying the proof.
   */
  trustedKeys: readonly Uint8Array[];
}

/** Public keys are public, so a plain comparison is fine here. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, i) => byte === b[i]);
}

/** The enrolled keys a proof may be checked against, narrowed by its hint. */
function candidateKeys(
  proof: DigestBoundPaymentProof,
  trustedKeys: readonly Uint8Array[],
): Uint8Array[] {
  const enrolled = trustedKeys.filter((key) => key.byteLength > 0);
  const hint = proof.publicKeySpki;
  if (hint === undefined || hint.byteLength === 0) return enrolled;
  return enrolled.filter((key) => sameBytes(key, hint));
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
  const signature = proof.verifiedBytes;
  if (signature === undefined || signature.byteLength === 0) {
    if (proof.mechanism !== undefined || proof.assurance !== undefined) {
      return { ok: false, reason: "unverified_assurance" };
    }
    return { ok: false, reason: "missing_verified_bytes" };
  }
  const keys = candidateKeys(proof, input.trustedKeys);
  if (keys.length === 0) {
    return { ok: false, reason: "key_not_enrolled" };
  }
  for (const key of keys) {
    // Verify against the enrolled copy, never the proof's own bytes.
    if (await verifyEs256(expectedDigest, signature, key)) {
      return { ok: true, verifiedMechanism: "es256" };
    }
  }
  return { ok: false, reason: "signature_invalid" };
}

export type EphemeralP256Proof = {
  verifiedBytes: Uint8Array;
  publicKeySpki: Uint8Array;
};

/** Browser-safe ephemeral P-256 signature over a digest. Test/demo only. */
export async function signDigestWithEphemeralP256(
  digestHex: string,
): Promise<EphemeralP256Proof> {
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
