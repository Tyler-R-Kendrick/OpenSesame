import { describe, expect, it } from "vitest";
import { assessExactPaymentCors } from "./cors.js";

const origin = "https://pages.example";

describe("assessExactPaymentCors (WAL-E12)", () => {
  it("accepts an exact origin with exposed payment headers and no redirect", () => {
    expect(
      assessExactPaymentCors({
        requestOrigin: origin,
        accessControlAllowOrigin: origin,
        accessControlExposeHeaders: "PAYMENT-REQUIRED, PAYMENT-SIGNATURE",
        credentialForwardingOnRedirect: false,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses wildcard or missing ACAO", () => {
    expect(
      assessExactPaymentCors({
        requestOrigin: origin,
        accessControlAllowOrigin: "*",
        accessControlExposeHeaders: "PAYMENT-REQUIRED, PAYMENT-SIGNATURE",
        credentialForwardingOnRedirect: false,
      }),
    ).toEqual({ ok: false, code: "CORS_ORIGIN_REFUSED" });
  });

  it("refuses unexposed payment headers", () => {
    expect(
      assessExactPaymentCors({
        requestOrigin: origin,
        accessControlAllowOrigin: origin,
        accessControlExposeHeaders: "content-type",
        credentialForwardingOnRedirect: false,
      }),
    ).toEqual({ ok: false, code: "CORS_HEADERS_UNEXPOSED" });
  });

  it("refuses forwarding credentials across a redirect", () => {
    expect(
      assessExactPaymentCors({
        requestOrigin: origin,
        accessControlAllowOrigin: origin,
        accessControlExposeHeaders: "PAYMENT-REQUIRED, PAYMENT-SIGNATURE",
        credentialForwardingOnRedirect: true,
        redirectStatus: 302,
      }),
    ).toEqual({ ok: false, code: "REDIRECT_CREDENTIAL_FORWARDING_REFUSED" });
  });
});
