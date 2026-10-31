import { describe, expect, it } from "vitest";
import {
  boatClaimHandoff,
  cloudflareClaimHandoff,
} from "./password-reset-claim.js";

const claim =
  "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=abc123";

describe("Boat human handoff", () => {
  it("accepts the documented claim link and six-digit code", () => {
    expect(
      boatClaimHandoff({ verificationUri: claim, userCode: "123456" }),
    ).toEqual({
      url: claim,
      userCode: "123456",
    });
  });

  it("accepts hosted Stripe checkout, including its fragment", () => {
    const checkout = "https://checkout.stripe.com/c/pay/cs_test_abc#fragment";
    expect(boatClaimHandoff({ verificationUri: checkout })).toEqual({
      url: checkout,
    });
  });

  it.each([
    "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=x\u001b[2J",
    "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=x\nmalicious",
    "http://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=x",
    "https://user:password@boat.dev/api/boat/agent/identity/claim?claim_attempt_token=x",
    "https://boat.dev.evil.example/api/boat/agent/identity/claim?claim_attempt_token=x",
    "https://boat.dev:8443/api/boat/agent/identity/claim?claim_attempt_token=x",
    "https://boat.dev/api/boat/agent/identity/claim",
    "https://boat.dev/api/boat/agent/identity/claim?claim_attempt_token=x&claim_attempt_token=y",
    "https://checkout.stripe.com.evil.example/c/pay/session",
    "https://evil.example/c/pay/session",
    `https://boat.dev/${"a".repeat(8192)}`,
  ])("rejects untrusted or unsafe URL %j", (verificationUri) => {
    expect(() =>
      boatClaimHandoff({ verificationUri, userCode: "123456" }),
    ).toThrow();
  });

  it.each(["", "12345", "1234567", "12\u001b[31m", "１２３４５６"])(
    "rejects unsafe or malformed claim code %j",
    (userCode) => {
      expect(() =>
        boatClaimHandoff({ verificationUri: claim, userCode }),
      ).toThrow();
    },
  );

  it("accepts the Cloudflare dashboard claim link", () => {
    const url = "https://dash.cloudflare.com/claim-preview?claimToken=abc123";
    expect(cloudflareClaimHandoff({ verificationUri: url })).toEqual({
      url,
    });
  });

  it.each([
    "https://dash.cloudflare.com/claim-preview",
    "https://dash.cloudflare.com/claim-preview?claimToken=x&claimToken=y",
    "https://dash.cloudflare.com/claim-preview?claimToken=x#fragment",
    "https://dash.cloudflare.com.evil.example/claim-preview?claimToken=x",
    "http://dash.cloudflare.com/claim-preview?claimToken=x",
    "https://dash.cloudflare.com/other?claimToken=x",
  ])("rejects unsafe Cloudflare claim URL %j", (verificationUri) => {
    expect(() => cloudflareClaimHandoff({ verificationUri })).toThrow();
  });

  it("rejects claim codes attached to checkout and claim fragments", () => {
    expect(() =>
      boatClaimHandoff({
        verificationUri: "https://checkout.stripe.com/c/pay/session",
        userCode: "123456",
      }),
    ).toThrow();
    expect(() =>
      boatClaimHandoff({
        verificationUri: `${claim}#fragment`,
        userCode: "123456",
      }),
    ).toThrow();
  });
});
