/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { assertSopsHttpsEndpoint, awsKeysMatch } from "./cloud-endpoint.js";
import { matchRe2 } from "./selectors.js";

describe("sops policy and cloud locators", () => {
  it("rejects lookaround and private endpoints", () => {
    expect(() => matchRe2("(?=secret)", "secret")).toThrow(/unsupported regex/);
    expect(matchRe2("^secret$", "secret")).toBe(true);
    expect(() => assertSopsHttpsEndpoint("http://example.com")).toThrow(
      /https/,
    );
    expect(() =>
      assertSopsHttpsEndpoint("https://169.254.169.254/latest"),
    ).toThrow(/public/);
    expect(() =>
      assertSopsHttpsEndpoint("https://user:pass@example.com"),
    ).toThrow(/userinfo/);
    const key = "arn:aws:kms:us-east-1:111122223333:key/abcd";
    expect(awsKeysMatch(key, key)).toBe(true);
    expect(awsKeysMatch(key, `${key}-other`)).toBe(false);
    expect(awsKeysMatch(key, "abcd")).toBe(false);
  });
});
