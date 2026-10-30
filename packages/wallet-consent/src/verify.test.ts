import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
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

  it("verifies views with nonzero offsets and cross-realm backing buffers", async () => {
    const proof = signedProof(DIGEST);
    const signature = new Uint8Array(proof.verifiedBytes.length + 4);
    signature.set(proof.verifiedBytes, 2);
    const key = runInNewContext("Uint8Array.from(bytes)", {
      bytes: [...ENROLLED.publicKeySpki],
    });
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: [key],
        proof: {
          boundDigest: DIGEST,
          verifiedBytes: signature.subarray(2, -2),
        },
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });

  it("refuses shared signature and enrolled-key backing buffers", async () => {
    const proof = signedProof(DIGEST);
    const signature = new Uint8Array(
      new SharedArrayBuffer(proof.verifiedBytes.length),
    );
    signature.set(proof.verifiedBytes);
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { ...proof, verifiedBytes: signature },
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
    const key = new Uint8Array(
      new SharedArrayBuffer(ENROLLED.publicKeySpki.length),
    );
    key.set(ENROLLED.publicKeySpki);
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: [key],
        proof,
      }),
    ).toEqual({ ok: false, reason: "signature_invalid" });
  });

  it("checks the intrinsic backing buffer when a shared view spoofs buffer", async () => {
    const proof = signedProof(DIGEST);
    const signature = new Uint8Array(
      new SharedArrayBuffer(proof.verifiedBytes.length),
    );
    signature.set(proof.verifiedBytes);
    Object.defineProperty(signature, "buffer", {
      value: new ArrayBuffer(signature.length),
    });
    const verify = vi.spyOn(crypto.subtle, "verify");
    try {
      expect(
        await verifyDigestBoundApproval({
          expectedDigest: DIGEST,
          trustedKeys: TRUSTED,
          proof: { ...proof, verifiedBytes: signature },
        }),
      ).toEqual({ ok: false, reason: "signature_invalid" });
      expect(verify).not.toHaveBeenCalled();
    } finally {
      verify.mockRestore();
    }
  });

  it("accepts an ordinary view even if its buffer property is spoofed", async () => {
    const proof = signedProof(DIGEST);
    const signature = new Uint8Array(proof.verifiedBytes);
    Object.defineProperty(signature, "buffer", {
      value: new SharedArrayBuffer(signature.length),
    });
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { ...proof, verifiedBytes: signature },
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });

  it("refuses a signature detached while the enrolled key is importing", async () => {
    const proof = signedProof(DIGEST);
    const signature = new Uint8Array(proof.verifiedBytes);
    const original = crypto.subtle.importKey.bind(crypto.subtle);
    const importing = vi
      .spyOn(crypto.subtle, "importKey")
      .mockImplementationOnce(async (...args) => {
        const key = await Reflect.apply(original, crypto.subtle, args);
        structuredClone(signature.buffer, { transfer: [signature.buffer] });
        return key;
      });
    try {
      expect(
        await verifyDigestBoundApproval({
          expectedDigest: DIGEST,
          trustedKeys: TRUSTED,
          proof: { ...proof, verifiedBytes: signature },
        }),
      ).toEqual({ ok: false, reason: "signature_invalid" });
    } finally {
      importing.mockRestore();
    }
  });

  it("refuses a detached signature without throwing", async () => {
    const proof = signedProof(DIGEST);
    const signature = new Uint8Array(proof.verifiedBytes);
    structuredClone(signature.buffer, { transfer: [signature.buffer] });
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: DIGEST,
        trustedKeys: TRUSTED,
        proof: { ...proof, verifiedBytes: signature },
      }),
    ).toEqual({ ok: false, reason: "missing_verified_bytes" });
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
