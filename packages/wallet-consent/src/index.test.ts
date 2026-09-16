import { describe, expect, it } from "vitest";
import {
  buildPaymentApprovalDigest,
  verifyDigestBoundApproval,
} from "./index.js";

describe("@opensesame/wallet-consent exports", () => {
  it("exposes digest build and verify", () => {
    const digest = buildPaymentApprovalDigest({
      currency: "USD",
      amount: "1.00",
      recipient: "A",
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyDigestBoundApproval({
        expectedDigest: digest,
        proof: { boundDigest: digest, mechanism: "webauthn" },
      }).ok,
    ).toBe(false);
  });
});
