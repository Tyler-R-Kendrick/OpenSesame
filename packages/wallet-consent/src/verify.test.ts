import { describe, expect, it } from "vitest";
import { buildPaymentApprovalDigest } from "./digest.js";
import {
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "./keys.js";
import {
  signDigestWithEphemeralP256,
  verifyDigestBoundApproval,
} from "./verify.js";

const DIGEST = buildPaymentApprovalDigest({
  currency: "USD",
  amount: "10.00",
  recipient: "Merchant",
  assetNetwork: "eip155:1",
  assetId: "0xtoken",
  maxFee: "0",
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2026-12-31T00:00:00.000Z",
  policyVersion: "1",
  allocationRef: "alloc-root",
  effectiveEnforcement: "local_approval",
});

const ENROLLED = generatePaymentApprovalKeyPair();
const TRUSTED = [ENROLLED.publicKeySpki];

function signedProof(digest: string, keys = ENROLLED) {
  return {
    boundDigest: digest,
    verifiedBytes: signPaymentApprovalDigest(digest, keys.privateKeyPkcs8),
    publicKeySpki: keys.publicKeySpki,
  };
}

describe("verifyDigestBoundApproval", () => {
  it("admits a matching digest with a verified ES256 signature", async () => {
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { ...signedProof(DIGEST), mechanism: "webauthn" },
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });

  it("rejects forged mechanism:webauthn without verified bytes", async () => {
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { boundDigest: DIGEST, mechanism: "webauthn" },
      }),
    ).toEqual({ ok: false, reason: "unverified_assurance" });
  });

  it("rejects dummy bytes that are not a signature", async () => {
    const keys = ENROLLED;
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: {
          boundDigest: DIGEST,
          verifiedBytes: new Uint8Array([1, 2, 3]),
          publicKeySpki: keys.publicKeySpki,
        },
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("rejects digest mismatch", async () => {
    const tampered = buildPaymentApprovalDigest({
      currency: "USD",
      amount: "999.00",
      recipient: "Merchant",
      assetNetwork: "eip155:1",
      assetId: "0xtoken",
      maxFee: "0",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-12-31T00:00:00.000Z",
      policyVersion: "1",
      allocationRef: "alloc-root",
      effectiveEnforcement: "local_approval",
    });
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: signedProof(tampered),
      }),
    ).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("refuses a proof naming a key that is not enrolled", async () => {
    const proof = signedProof(DIGEST);
    const other = generatePaymentApprovalKeyPair();
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { ...proof, publicKeySpki: other.publicKeySpki },
      }),
    ).toEqual({ ok: false, reason: "key_not_enrolled" });
  });

  it("refuses an approval self-signed with an ephemeral key", async () => {
    const selfSigned = await signDigestWithEphemeralP256(DIGEST);
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { boundDigest: DIGEST, ...selfSigned },
      }),
    ).toEqual({ ok: false, reason: "key_not_enrolled" });
    // Same signature with the key hint stripped: checked only against the
    // enrolled key, which did not sign it.
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { boundDigest: DIGEST, verifiedBytes: selfSigned.verifiedBytes },
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("refuses everything when nothing is enrolled", async () => {
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: [],
        proof: signedProof(DIGEST),
      }),
    ).toEqual({ ok: false, reason: "key_not_enrolled" });
  });

  it("verifies against the enrolled key when the proof omits a hint", async () => {
    const { publicKeySpki: _hint, ...bare } = signedProof(DIGEST);
    const other = generatePaymentApprovalKeyPair();
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: [other.publicKeySpki, ENROLLED.publicKeySpki],
        proof: bare,
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });

  it("rejects a bare digest match with no bytes", async () => {
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { boundDigest: DIGEST },
      }),
    ).toEqual({ ok: false, reason: "missing_verified_bytes" });
  });
});
