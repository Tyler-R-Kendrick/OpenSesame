/** @vitest-environment jsdom */
import {
  PAYMENT_APPROVAL_DIGEST_FIELD_ORDER,
  type PaymentApprovalDigestField,
  buildPaymentApprovalDigest,
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "@opensesame/wallet-consent";
import { describe, expect, it } from "vitest";
import {
  assessLocalPaymentApproval,
  buildLocalPaymentApprovalDigest,
  localPaymentApprovalIntent,
} from "./spending-consent.js";

const TAMPER = {
  currency: "EUR",
  amount: "701",
  recipient: "child-b",
  assetNetwork: "eip155:1",
  assetId: "0xother",
  maxFee: "9",
  validFrom: "2026-06-01T00:00:00.000Z",
  validUntil: "2027-01-01T00:00:00.000Z",
  policyVersion: "2",
  allocationRef: "child-b",
  effectiveEnforcement: "independent_execution",
} satisfies Record<PaymentApprovalDigestField, string>;

describe("spending-consent", () => {
  it("matches the Node wallet-consent digest encoding", async () => {
    const intent = localPaymentApprovalIntent({
      amount: "700",
      recipient: "child-a",
    });
    const browser = await buildLocalPaymentApprovalDigest(intent);
    expect(browser).toBe(buildPaymentApprovalDigest(intent));
    expect(browser).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(PAYMENT_APPROVAL_DIGEST_FIELD_ORDER)(
    "invalidates approval when %s is tampered after signing (WAL-B02)",
    async (field) => {
      const honest = localPaymentApprovalIntent({ amount: "700" });
      const digest = await buildLocalPaymentApprovalDigest(honest);
      const keys = generatePaymentApprovalKeyPair();
      const proof = {
        boundDigest: digest,
        verifiedBytes: signPaymentApprovalDigest(digest, keys.privateKeyPkcs8),
        publicKeySpki: keys.publicKeySpki,
      };
      const admitted = await assessLocalPaymentApproval({
        intent: honest,
        proof,
      });
      expect(admitted).toEqual({ ok: true, verifiedMechanism: "es256" });

      const tampered = localPaymentApprovalIntent({
        amount: "700",
        [field]: TAMPER[field],
      });
      const refused = await assessLocalPaymentApproval({
        intent: tampered,
        proof,
      });
      expect(refused).toEqual({ ok: false, reason: "digest_mismatch" });
    },
  );

  it("refuses forged assurance without a verified signature (WAL-B01)", async () => {
    const intent = localPaymentApprovalIntent({ amount: "700" });
    const digest = await buildLocalPaymentApprovalDigest(intent);
    const forged = await assessLocalPaymentApproval({
      intent,
      proof: {
        boundDigest: digest,
        mechanism: "webauthn",
        assurance: "phishing_resistant",
      },
    });
    expect(forged).toEqual({ ok: false, reason: "unverified_assurance" });

    const mismatch = await assessLocalPaymentApproval({
      intent,
      proof: {
        boundDigest: "0".repeat(64),
        verifiedBytes: new Uint8Array([1, 2, 3]),
      },
    });
    expect(mismatch).toEqual({ ok: false, reason: "digest_mismatch" });

    const dummyKeys = generatePaymentApprovalKeyPair();
    const dummyBytes = await assessLocalPaymentApproval({
      intent,
      proof: {
        boundDigest: digest,
        verifiedBytes: new Uint8Array([1, 2, 3]),
        publicKeySpki: dummyKeys.publicKeySpki,
      },
    });
    expect(dummyBytes).toEqual({ ok: false, reason: "signature_invalid" });
  });
});
