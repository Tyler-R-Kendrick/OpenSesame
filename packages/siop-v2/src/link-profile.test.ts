import { describe, expect, it } from "vitest";
import { isSiopV2Error } from "./errors.js";
import { STATIC_SELF_ISSUED_ISSUER } from "./issuer.js";
import {
  bodyOffersEmailJoin,
  challengeIssuerFromProfile,
  resolveSiopLinkProfile,
} from "./link-profile.js";

function expectIssuerRefusal(run: () => void): void {
  try {
    run();
    expect.unreachable("expected issuer_mismatch");
  } catch (err) {
    expect(err instanceof Error && isSiopV2Error(err)).toBe(true);
    if (err instanceof Error && isSiopV2Error(err)) {
      expect(err.code).toBe("issuer_mismatch");
      expect(err.checkpoint).toBe("issuer_profile");
    }
  }
}

describe("resolveSiopLinkProfile", () => {
  it("defaults to the static Self-Issued issuer", () => {
    expect(resolveSiopLinkProfile({})).toEqual({ kind: "static" });
    expect(
      resolveSiopLinkProfile({ expectedIssuer: STATIC_SELF_ISSUED_ISSUER }),
    ).toEqual({ kind: "static" });
  });

  it("selects dynamic when expectedIssuer is a non-static URL", () => {
    const issuer = "https://siop.example.com/v2";
    expect(resolveSiopLinkProfile({ expectedIssuer: issuer })).toEqual({
      kind: "dynamic",
      issuer,
    });
  });

  it("requireDynamicSiopMarker refuses missing or static issuers", () => {
    expectIssuerRefusal(() =>
      resolveSiopLinkProfile({ requireDynamicSiopMarker: true }),
    );
    expectIssuerRefusal(() =>
      resolveSiopLinkProfile({
        requireDynamicSiopMarker: true,
        expectedIssuer: STATIC_SELF_ISSUED_ISSUER,
      }),
    );
    expectIssuerRefusal(() =>
      resolveSiopLinkProfile({
        requireDynamicSiopMarker: true,
        expectedIssuer: "   ",
      }),
    );
  });

  it("requireDynamicSiopMarker trims and accepts a dynamic issuer", () => {
    const issuer = "https://siop.example.com/v2";
    expect(
      resolveSiopLinkProfile({
        requireDynamicSiopMarker: true,
        expectedIssuer: `  ${issuer}  `,
      }),
    ).toEqual({ kind: "dynamic", issuer });
  });

  it("requireDynamicSiopMarker still refuse-checks the issuer URL", () => {
    expectIssuerRefusal(() =>
      resolveSiopLinkProfile({
        requireDynamicSiopMarker: true,
        expectedIssuer: "http://evil.example/siop",
      }),
    );
    expectIssuerRefusal(() =>
      resolveSiopLinkProfile({
        expectedIssuer: "http://evil.example/siop",
      }),
    );
  });

  it("accepts loopback HTTP dynamic issuers", () => {
    for (const issuer of [
      "http://localhost:5180/siop",
      "http://127.0.0.1:8788/siop",
      "http://[::1]:9090/siop",
    ]) {
      expect(
        resolveSiopLinkProfile({
          requireDynamicSiopMarker: true,
          expectedIssuer: issuer,
        }),
      ).toEqual({ kind: "dynamic", issuer });
    }
  });
});

describe("challengeIssuerFromProfile", () => {
  it("maps static and dynamic profiles to their issuer strings", () => {
    expect(challengeIssuerFromProfile({ kind: "static" })).toBe(
      STATIC_SELF_ISSUED_ISSUER,
    );
    expect(
      challengeIssuerFromProfile({
        kind: "dynamic",
        issuer: "https://siop.example.com/v2",
      }),
    ).toBe("https://siop.example.com/v2");
  });
});

describe("bodyOffersEmailJoin", () => {
  it("is true when either email field is present, including null", () => {
    expect(bodyOffersEmailJoin({})).toBe(false);
    expect(bodyOffersEmailJoin({ email: undefined })).toBe(false);
    expect(bodyOffersEmailJoin({ email: "a@b.c" })).toBe(true);
    expect(bodyOffersEmailJoin({ emailNormalized: "a@b.c" })).toBe(true);
    expect(bodyOffersEmailJoin({ email: null })).toBe(true);
    expect(bodyOffersEmailJoin({ emailNormalized: null })).toBe(true);
  });
});
