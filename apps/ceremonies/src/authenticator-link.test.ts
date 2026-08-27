import { describe, expect, it } from "vitest";
import {
  AuthenticatorLinkError,
  parseAuthenticatorInvocation,
} from "./lib/authenticator-link.js";

describe("authenticator invocation links", () => {
  it("converts by-reference OID4VP and OID4VCI links to standard schemes", () => {
    expect(
      parseAuthenticatorInvocation(
        "oid4vp",
        "?request_uri=https%3A%2F%2Fverifier.example%2Frequest%2F1",
      ).appUrl,
    ).toBe(
      "openid4vp://?request_uri=https%3A%2F%2Fverifier.example%2Frequest%2F1",
    );
    expect(
      parseAuthenticatorInvocation(
        "oid4vci",
        "?request_uri=https%3A%2F%2Fissuer.example%2Foffer%2F1",
      ).appUrl,
    ).toBe(
      "openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fissuer.example%2Foffer%2F1",
    );
  });

  it("keeps the existing device ceremony as the MFA browser fallback", () => {
    const invocation = parseAuthenticatorInvocation(
      "mfa",
      "?user_code=abcd-1234",
    );
    expect(invocation.appUrl).toBe(
      "opensesame://invoke/mfa?user_code=ABCD-1234",
    );
    expect(invocation.browserFallback).toBe("/device?user_code=ABCD-1234");
  });

  it("rejects inline secrets, duplicates, non-HTTPS, and private networks", () => {
    const rejected = [
      ["oid4vci", "?credential_offer=secret"],
      ["oid4vp", "?request_id=a&request_id=b"],
      ["oid4vp", "?request_id=unresolvable"],
      ["oid4vp", "?request_uri=http%3A%2F%2Fverifier.example%2Frequest"],
      ["oid4vp", "?request_uri=https%3A%2F%2F127.0.0.1%2Frequest"],
      ["oid4vp", "?request_uri=https%3A%2F%2F192.168.1.1%2Frequest"],
      ["mfa", "?access_token=nope"],
    ] as const;
    for (const [kind, search] of rejected) {
      expect(() => parseAuthenticatorInvocation(kind, search)).toThrow(
        AuthenticatorLinkError,
      );
    }
  });
});
