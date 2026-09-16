import { describe, expect, it } from "vitest";
import { buildPaymentApprovalDigest } from "./digest.js";
import { verifyDigestBoundApproval } from "./verify.js";

const DIGEST = buildPaymentApprovalDigest({
  currency: "USD",
  amount: "10.00",
  recipient: "Merchant",
});

describe("verifyDigestBoundApproval", () => {
  it("admits a matching digest with verified assertion bytes", () => {
    const result = verifyDigestBoundApproval({
      expectedDigest: DIGEST,
      proof: {
        boundDigest: DIGEST,
        verifiedBytes: new Uint8Array([0x01, 0x02, 0x03]),
        mechanism: "webauthn",
        assurance: "phishing_resistant",
      },
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects a forged mechanism:webauthn string without verified bytes", () => {
    const result = verifyDigestBoundApproval({
      expectedDigest: DIGEST,
      proof: {
        boundDigest: DIGEST,
        mechanism: "webauthn",
        assurance: "phishing_resistant",
      },
    });
    expect(result).toEqual({ ok: false, reason: "unverified_assurance" });
  });

  it("rejects empty verified bytes even when mechanism is claimed", () => {
    const result = verifyDigestBoundApproval({
      expectedDigest: DIGEST,
      proof: {
        boundDigest: DIGEST,
        verifiedBytes: new Uint8Array(0),
        mechanism: "webauthn",
      },
    });
    expect(result).toEqual({ ok: false, reason: "unverified_assurance" });
  });

  it("rejects a digest mismatch even with verified bytes", () => {
    const tampered = buildPaymentApprovalDigest({
      currency: "USD",
      amount: "999.00",
      recipient: "Merchant",
    });
    const result = verifyDigestBoundApproval({
      expectedDigest: DIGEST,
      proof: {
        boundDigest: tampered,
        verifiedBytes: new Uint8Array([0xaa]),
      },
    });
    expect(result).toEqual({ ok: false, reason: "digest_mismatch" });
  });

  it("rejects a bare digest match with no verified bytes and no claims", () => {
    const result = verifyDigestBoundApproval({
      expectedDigest: DIGEST,
      proof: { boundDigest: DIGEST },
    });
    expect(result).toEqual({ ok: false, reason: "missing_verified_bytes" });
  });
});
