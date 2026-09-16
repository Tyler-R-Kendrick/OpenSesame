import { describe, expect, it } from "vitest";
import { isSiopV2Error } from "./errors.js";
import {
  STATIC_SELF_ISSUED_ISSUER,
  assertAllowedIssuer,
  resolveIssuer,
} from "./issuer.js";

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

describe("resolveIssuer — static profile", () => {
  it("returns the static Self-Issued issuer without i_am_siop", () => {
    expect(resolveIssuer({ kind: "static" })).toEqual({
      iss: STATIC_SELF_ISSUED_ISSUER,
      iAmSiop: false,
    });
  });
});

describe("resolveIssuer — dynamic profile", () => {
  it("accepts HTTPS issuers", () => {
    const issuer = "https://siop.example.com/v2";
    expect(resolveIssuer({ kind: "dynamic", issuer })).toEqual({
      iss: issuer,
      iAmSiop: true,
    });
  });

  it("refuses the static issuer URL as dynamic", () => {
    expectIssuerRefusal(() =>
      resolveIssuer({ kind: "dynamic", issuer: STATIC_SELF_ISSUED_ISSUER }),
    );
  });
});

describe("assertAllowedIssuer — URL shape", () => {
  it("refuses non-absolute issuers", () => {
    expectIssuerRefusal(() => assertAllowedIssuer("not-a-url"));
    expectIssuerRefusal(() => assertAllowedIssuer(""));
  });

  it("refuses embedded credentials", () => {
    expectIssuerRefusal(() =>
      assertAllowedIssuer("https://user@siop.example.com"),
    );
    expectIssuerRefusal(() =>
      assertAllowedIssuer("https://user:pass@siop.example.com"),
    );
    expectIssuerRefusal(() =>
      assertAllowedIssuer("https://:pass-only@siop.example.com"),
    );
  });

  it("refuses hash and query components", () => {
    expectIssuerRefusal(() =>
      assertAllowedIssuer("https://siop.example.com#frag"),
    );
    expectIssuerRefusal(() =>
      assertAllowedIssuer("https://siop.example.com?x=1"),
    );
  });

  it("refuses HTTPS spelled with wrong scheme casing", () => {
    expectIssuerRefusal(() => assertAllowedIssuer("HTTPS://siop.example.com"));
  });

  it("accepts lowercase https scheme prefix", () => {
    expect(() =>
      assertAllowedIssuer("https://siop.example.com/path"),
    ).not.toThrow();
  });
});

describe("assertAllowedIssuer — loopback HTTP", () => {
  it("accepts localhost, 127.0.0.1, and [::1]", () => {
    for (const issuer of [
      "http://localhost:5180/siop",
      "http://127.0.0.1:8788/siop",
      "http://[::1]:9090/siop",
    ]) {
      expect(() => assertAllowedIssuer(issuer)).not.toThrow();
      expect(resolveIssuer({ kind: "dynamic", issuer })).toMatchObject({
        iss: issuer,
      });
    }
  });

  it("accepts loopback hostnames regardless of casing", () => {
    expect(() => assertAllowedIssuer("http://LOCALHOST/siop")).not.toThrow();
  });

  it("refuses non-loopback HTTP", () => {
    expectIssuerRefusal(() => assertAllowedIssuer("http://evil.example/siop"));
    expectIssuerRefusal(() => assertAllowedIssuer("http://192.168.1.1/siop"));
  });

  it("refuses non-http(s) protocols", () => {
    expectIssuerRefusal(() => assertAllowedIssuer("file:///etc/passwd"));
    expectIssuerRefusal(() => assertAllowedIssuer("javascript:alert(1)"));
    expectIssuerRefusal(() => assertAllowedIssuer("ftp://localhost/siop"));
  });
});
