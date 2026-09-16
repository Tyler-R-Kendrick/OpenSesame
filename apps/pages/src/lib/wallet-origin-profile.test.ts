import { describe, expect, it } from "vitest";
import { assessRootWalletOperation } from "./wallet-origin-profile.js";

describe("assessRootWalletOperation (WAL-B08)", () => {
  it("allows secure contexts and refuses insecure/opaque origins", () => {
    expect(assessRootWalletOperation("secure_context_https")).toEqual({
      ok: true,
    });
    expect(assessRootWalletOperation("secure_context_localhost")).toEqual({
      ok: true,
    });
    const http = assessRootWalletOperation("insecure_http");
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.code).toBe("UNSUPPORTED_STATIC_SECURITY_PROFILE");
    const opaque = assessRootWalletOperation("opaque_origin");
    expect(opaque.ok).toBe(false);
  });
});
