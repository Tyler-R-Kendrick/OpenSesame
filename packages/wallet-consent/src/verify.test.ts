import { describe, expect, it } from "vitest";
import { buildPaymentApprovalDigest } from "./digest.js";
import {
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "./keys.js";
import { verifyDigestBoundApproval } from "./verify.js";

const DIGEST = buildPaymentApprovalDigest({
  currency: "USD",
  amount: "10.00",
  recipient: "Merchant",
});

function signedProof(digest: string) {
  const keys = generatePaymentApprovalKeyPair();
  return {
    boundDigest: digest,
    verifiedBytes: signPaymentApprovalDigest(digest, keys.privateKeyPkcs8),
    publicKeySpki: keys.publicKeySpki,
  };
}

describe("verifyDigestBoundApproval", () => {
  it("admits a matching digest with a verified ES256 signature", () => {
    expect(
      verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        proof: { ...signedProof(DIGEST), mechanism: "webauthn" },
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });

  it("rejects forged mechanism:webauthn without verified bytes", () => {
    expect(
      verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        proof: { boundDigest: DIGEST, mechanism: "webauthn" },
      }),
    ).toEqual({ ok: false, reason: "unverified_assurance" });
  });

  it("rejects dummy bytes that are not a signature", () => {
    const keys = generatePaymentApprovalKeyPair();
    expect(
      verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        proof: {
          boundDigest: DIGEST,
          verifiedBytes: new Uint8Array([1, 2, 3]),
          publicKeySpki: keys.publicKeySpki,
        },
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects digest mismatch", () => {
    const tampered = buildPaymentApprovalDigest({
      currency: "USD",
      amount: "999.00",
      recipient: "Merchant",
    });
    expect(
      verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        proof: signedProof(tampered),
      }),
    ).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("rejects a signature from a different key", () => {
    const proof = signedProof(DIGEST);
    const other = generatePaymentApprovalKeyPair();
    expect(
      verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        proof: { ...proof, publicKeySpki: other.publicKeySpki },
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects a bare digest match with no bytes", () => {
    expect(
      verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        proof: { boundDigest: DIGEST },
      }),
    ).toEqual({ ok: false, reason: "missing_verified_bytes" });
  });
});
