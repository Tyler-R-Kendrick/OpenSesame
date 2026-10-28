import { describe, expect, it } from "vitest";
import { providerTemplate } from "./native-api-target.js";

describe("provider URL substitution", () => {
  it("refuses dot segments formed by one or multiple substitutions", () => {
    expect(() =>
      providerTemplate("/v1/{tenant}/status", { tenant: ".." }, {}, true),
    ).toThrow("valid provider parameters");
    expect(() =>
      providerTemplate(
        "/v1/{first}{second}/status",
        { first: ".", second: "." },
        {},
        true,
      ),
    ).toThrow("valid provider parameters");
  });

  it("retains dot values in queries and partial path segments", () => {
    expect(
      providerTemplate("/v1/status?q={tenant}", { tenant: ".." }, {}, true),
    ).toBe("/v1/status?q=..");
    expect(
      providerTemplate("/v1/prefix{tenant}/status", { tenant: ".." }, {}, true),
    ).toBe("/v1/prefix../status");
  });
});
