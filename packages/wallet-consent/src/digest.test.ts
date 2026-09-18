import { describe, expect, it } from "vitest";
import {
  PAYMENT_APPROVAL_DIGEST_FIELD_ORDER,
  PAYMENT_APPROVAL_DIGEST_VERSION,
  type PaymentApprovalDigestField,
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
    assetNetwork: "eip155:1",
    assetId: "0xtoken",
    maxFee: "1.00",
    validFrom: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-12-31T00:00:00.000Z",
    policyVersion: "1",
    allocationRef: "alloc-root",
    effectiveEnforcement: "independent_execution",
    ...overrides,
  };
}

const TAMPER = {
  currency: "EUR",
  amount: "42.01",
  recipient: "Evil Corp",
  assetNetwork: "eip155:31337",
  assetId: "0xother",
  maxFee: "9.00",
  validFrom: "2026-06-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  policyVersion: "2",
  allocationRef: "alloc-other",
  effectiveEnforcement: "local_approval",
} satisfies Record<PaymentApprovalDigestField, string>

describe("buildPaymentApprovalDigest", () => {
  it("returns a stable 64-char lowercase hex digest", () => {
    const a = buildPaymentApprovalDigest(intent());
    const b = buildPaymentApprovalDigest(intent());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(PAYMENT_APPROVAL_DIGEST_VERSION).toBe(2);
  });

  it.each(PAYMENT_APPROVAL_DIGEST_FIELD_ORDER)(
    "changes when %s is tampered",
    (field) => {
      const honest = buildPaymentApprovalDigest(intent());
      const tampered = buildPaymentApprovalDigest(
        intent({ [field]: TAMPER[field] }),
      );
      expect(tampered).not.toBe(honest);
    },
  );

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
