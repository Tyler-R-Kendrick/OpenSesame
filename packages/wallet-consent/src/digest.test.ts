import { describe, expect, it } from "vitest";
import {
  PAYMENT_APPROVAL_DIGEST_VERSION,
  type PaymentApprovalIntent,
  buildPaymentApprovalDigest,
} from "./digest.js";

function intent(
  overrides: Partial<PaymentApprovalIntent> = {},
): PaymentApprovalIntent {
  return {
    currency: "USD",
    amount: "42.00",
    recipient: "Example Vendor",
    ...overrides,
  };
}

describe("buildPaymentApprovalDigest", () => {
  it("returns a stable 64-char lowercase hex digest", () => {
    const a = buildPaymentApprovalDigest(intent());
    const b = buildPaymentApprovalDigest(intent());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(PAYMENT_APPROVAL_DIGEST_VERSION).toBe(1);
  });

  it("changes when the amount is tampered", () => {
    const honest = buildPaymentApprovalDigest(intent());
    const raised = buildPaymentApprovalDigest(intent({ amount: "42.01" }));
    expect(raised).not.toBe(honest);
  });

  it("changes when the recipient is tampered", () => {
    const honest = buildPaymentApprovalDigest(intent());
    const swapped = buildPaymentApprovalDigest(
      intent({ recipient: "Evil Corp" }),
    );
    expect(swapped).not.toBe(honest);
  });

  it("changes when the currency is tampered", () => {
    expect(buildPaymentApprovalDigest(intent({ currency: "EUR" }))).not.toBe(
      buildPaymentApprovalDigest(intent()),
    );
  });

  it("does not collide when text moves across a field boundary", () => {
    const a = buildPaymentApprovalDigest(
      intent({ amount: "1", recipient: "00Vendor" }),
    );
    const b = buildPaymentApprovalDigest(
      intent({ amount: "100", recipient: "Vendor" }),
    );
    expect(a).not.toBe(b);
  });
});
