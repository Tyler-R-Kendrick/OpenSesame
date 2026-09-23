import { describe, expect, it } from "vitest";
import {
  buildPaymentApprovalDigest,
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
  verifyDigestBoundApproval,
} from "./index.js";

describe("@opensesame/wallet-consent exports", () => {
  it("exposes digest build and cryptographic verify", async () => {
    const digest = buildPaymentApprovalDigest({
      currency: "USD",
      amount: "1.00",
      recipient: "A",
      assetNetwork: "eip155:1",
      assetId: "0xtoken",
      maxFee: "0",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: "2026-12-31T00:00:00.000Z",
      policyVersion: "1",
      allocationRef: "alloc-root",
      effectiveEnforcement: "local_approval",
    });
    const forged = await verifyDigestBoundApproval({
      expectedDigest: digest,
      proof: { boundDigest: digest, mechanism: "webauthn" },
      trustedKeys: [],
    });
    expect(forged.ok).toBe(false);
    const keys = generatePaymentApprovalKeyPair();
    expect(
      await verifyDigestBoundApproval({
        expectedDigest: digest,
        proof: {
          boundDigest: digest,
          verifiedBytes: signPaymentApprovalDigest(
            digest,
            keys.privateKeyPkcs8,
          ),
          publicKeySpki: keys.publicKeySpki,
        },
        trustedKeys: [keys.publicKeySpki],
      }),
    ).toEqual({ ok: true, verifiedMechanism: "es256" });
  });
});
