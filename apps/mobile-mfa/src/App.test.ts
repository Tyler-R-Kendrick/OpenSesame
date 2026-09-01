import { describe, expect, it } from "vitest";
import { identityBase } from "./identity.js";

describe("mobile-mfa", () => {
  it("defaults to the Identity API with no trailing slash to double up", () => {
    // Every URL in the app is built by concatenation, so a trailing slash here
    // would produce `//v1/...` — which some proxies normalize, some route
    // elsewhere, and none of them agree about.
    expect(identityBase).toBe("http://127.0.0.1:8788");
  });
});
