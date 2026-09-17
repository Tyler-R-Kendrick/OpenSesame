import { describe, expect, it } from "vitest";
import {
  buildPaymentApprovalDigest,
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
  verifyDigestBoundApproval,
} from "./index.js";

describe("@opensesame/wallet-consent exports", () => {
  it("exposes digest build and cryptographic verify", () => {
    const digest = buildPaymentApprovalDigest({
      currency: "USD",
      amount: "1.00",
      recipient: "A",
    });
    expect(
      verifyDigestBoundApproval({
        expectedDigest: digest,
        proof: { boundDigest: digest, mechanism: "webauthn" },
      }).ok,
    ).toBe(false);
    const keys = generatePaymentApprovalKeyPair();
    expect(
      verifyDigestBoundApproval({
        expectedDigest: digest,
        proof: {
          boundDigest: digest,
          verifiedBytes: signPaymentApprovalDigest(digest, keys.privateKeyPkcs8),
          publicKeySpki: keys.publicKeySpki,
        },
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });
});
