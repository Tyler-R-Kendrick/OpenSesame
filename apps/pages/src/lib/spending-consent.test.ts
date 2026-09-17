/** @vitest-environment jsdom */
import { createHash } from "node:crypto";
import {
  generatePaymentApprovalKeyPair,
  signPaymentApprovalDigest,
} from "@opensesame/wallet-consent";
import { describe, expect, it } from "vitest";
import { buildLocalPaymentApprovalDigest } from "./spending-consent.js";

function nodeReferenceDigest(intent: {
  currency: string;
  amount: string;
  recipient: string;
}): string {
  const purpose = "opensesame:wallet-payment-approval:v1";
  const hash = createHash("sha256");
  for (const value of [
    purpose,
    intent.currency,
    intent.amount,
    intent.recipient,
  ]) {
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update("\0");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

describe("spending-consent", () => {
  it("matches the Node wallet-consent digest encoding", async () => {
    const intent = {
      currency: "TEST",
      amount: "700",
      recipient: "child-a",
    };
    const browser = await buildLocalPaymentApprovalDigest(intent);
    expect(browser).toBe(nodeReferenceDigest(intent));
    expect(browser).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when amount or recipient changes (WAL-B02)", async () => {
    const base = await buildLocalPaymentApprovalDigest({
      currency: "TEST",
      amount: "700",
      recipient: "child-a",
    });
    const changedAmount = await buildLocalPaymentApprovalDigest({
      currency: "TEST",
      amount: "701",
      recipient: "child-a",
    });
    const changedRecipient = await buildLocalPaymentApprovalDigest({
      currency: "TEST",
      amount: "700",
      recipient: "child-b",
    });
    expect(changedAmount).not.toBe(base);
    expect(changedRecipient).not.toBe(base);
  });

  it("refuses forged assurance without a verified signature (WAL-B01)", async () => {
    const { assessLocalPaymentApproval } = await import(
      "./spending-consent.js"
    );
    const intent = {
      currency: "TEST",
      amount: "700",
      recipient: "child-a",
    };
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

    const keys = generatePaymentApprovalKeyPair();
    const verifiedBytes = signPaymentApprovalDigest(
      digest,
      keys.privateKeyPkcs8,
    );
    const ok = await assessLocalPaymentApproval({
      intent,
      proof: {
        boundDigest: digest,
        verifiedBytes,
        publicKeySpki: keys.publicKeySpki,
      },
    });
    expect(ok).toEqual({ ok: true, verifiedMechanism: "es256" });
  });
});
