import { describe, expect, it } from "vitest";
import {
  AuthenticatorInvocationError,
  parseAuthenticatorInvocation,
} from "./authenticator-invocation.js";
import { CEREMONY_ROUTES } from "./ceremony-routes.js";

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
    const offer = parseAuthenticatorInvocation(
      "oid4vci",
      "?request_uri=https%3A%2F%2Fissuer.example%2Foffer%2F1",
    );
    expect(offer.appUrl).toBe(
      "openid-credential-offer://?credential_offer_uri=https%3A%2F%2Fissuer.example%2Foffer%2F1",
    );
    expect(offer.requestHost).toBe("issuer.example");
    expect(offer.browserFallback).toBeNull();
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
    expect(invocation.browserFallback).toBe(
      `${CEREMONY_ROUTES.device.path}?user_code=ABCD-1234`,
    );
  });

  it("hands a request id to the app with no browser fallback", () => {
    expect(parseAuthenticatorInvocation("mfa", "?request_id=r-1.x")).toEqual({
      kind: "mfa",
      handleName: "request_id",
      handle: "r-1.x",
      appUrl: "opensesame://invoke/mfa?request_id=r-1.x",
      browserFallback: null,
      requestHost: null,
    });
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
      ["mfa", "?accessToken=nope"],
      ["mfa", "?user_code=A&request_id=B"],
      ["mfa", "?user_code=bad%20code"],
      ["mfa", ""],
    ] as const;
    for (const [kind, search] of rejected) {
      expect(() => parseAuthenticatorInvocation(kind, search)).toThrow(
        AuthenticatorInvocationError,
      );
    }
  });

  it("says why a handle does not fit the kind", () => {
    const message = (
      kind: "mfa" | "oid4vp" | "oid4vci",
      search: string,
    ): string => {
      try {
        parseAuthenticatorInvocation(kind, search);
      } catch (error) {
        return error instanceof Error ? error.message : "";
      }
      return "";
    };
    expect(message("mfa", "?request_uri=https%3A%2F%2Fx.example%2F")).toBe(
      "MFA links cannot contain a remote request URI.",
    );
    expect(message("oid4vp", "?user_code=ABCD")).toBe(
      "Protocol links cannot contain an MFA user code.",
    );
    expect(message("oid4vci", "?request_id=r1")).toBe(
      "Protocol links require a standard HTTPS request URI.",
    );
    expect(message("mfa", "?credential_offer=x")).toBe(
      "This link contains credential material and was refused.",
    );
    expect(message("mfa", "?utm_source=x")).toBe(
      "This link contains an unsupported parameter.",
    );
  });
});
