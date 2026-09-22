/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { assertSopsHttpsEndpoint, awsKeysMatch } from "./cloud-endpoint.js";

describe("SB-051/052 SOPS cloud locators are untrusted", () => {
  it("refuses a non-HTTPS, private, loopback, metadata, or userinfo endpoint", () => {
    expect(() => assertSopsHttpsEndpoint("http://example.com")).toThrow(
      /https/u,
    );
    expect(() =>
      assertSopsHttpsEndpoint("https://169.254.169.254/latest"),
    ).toThrow(/public/u);
    expect(() =>
      assertSopsHttpsEndpoint("https://metadata.google.internal/x"),
    ).toThrow(/public/u);
    expect(() => assertSopsHttpsEndpoint("https://localhost:8200/v1")).toThrow(
      /public/u,
    );
    expect(() => assertSopsHttpsEndpoint("https://127.0.0.1/v1")).toThrow(
      /public/u,
    );
    expect(() => assertSopsHttpsEndpoint("https://10.0.0.5/v1")).toThrow(
      /public/u,
    );
    expect(() => assertSopsHttpsEndpoint("https://192.168.1.10/v1")).toThrow(
      /public/u,
    );
    expect(() => assertSopsHttpsEndpoint("https://172.16.4.4/v1")).toThrow(
      /public/u,
    );
    expect(() =>
      assertSopsHttpsEndpoint("https://vault.internal.local/v1"),
    ).toThrow(/public/u);
    expect(() =>
      assertSopsHttpsEndpoint("https://user:pass@example.com"),
    ).toThrow(/userinfo/u);
    expect(() => assertSopsHttpsEndpoint("not a url")).toThrow(/malformed/u);
    expect(() =>
      assertSopsHttpsEndpoint("https://kms.us-east-1.amazonaws.com/"),
    ).not.toThrow();
  });

  it("binds an AWS key by its full canonical identity, never a substring", () => {
    const key = "arn:aws:kms:us-east-1:111122223333:key/abcd";
    expect(awsKeysMatch(key, key)).toBe(true);
    expect(awsKeysMatch(key, `${key}-other`)).toBe(false);
    expect(awsKeysMatch(key, "abcd")).toBe(false);
    expect(
      awsKeysMatch(key, "arn:aws:kms:us-east-2:111122223333:key/abcd"),
    ).toBe(false);
    expect(awsKeysMatch("", "")).toBe(false);
  });
});
