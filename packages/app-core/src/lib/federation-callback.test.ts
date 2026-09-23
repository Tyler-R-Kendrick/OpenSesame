import { describe, expect, it } from "vitest";
import { assertSafeReturnTo } from "./federation-callback.js";

describe("assertSafeReturnTo", () => {
  it("OIDC-RETURN: refuses absolute and protocol-relative URLs", () => {
    expect(
      assertSafeReturnTo("https://evil.example/", "https://app.example", "/"),
    ).toBeUndefined();
    expect(
      assertSafeReturnTo("//evil.example/x", "https://app.example", "/"),
    ).toBeUndefined();
  });

  it("OIDC-RETURN: GitHub Pages base path cannot escape /OpenSesame/", () => {
    expect(
      assertSafeReturnTo("/settings", "https://app.example", "/OpenSesame/"),
    ).toBeUndefined();
    expect(
      assertSafeReturnTo(
        "/OpenSesame/settings",
        "https://app.example",
        "/OpenSesame/",
      ),
    ).toBe("/OpenSesame/settings");
  });

  it("OIDC-RETURN: dot segments cannot resolve to a protocol-relative path", () => {
    for (const candidate of [
      "/OpenSesame/..//evil.com",
      "/OpenSesame/%2e%2e//evil.com",
      "/OpenSesame/a/../..//evil.com",
    ]) {
      expect(
        assertSafeReturnTo(candidate, "https://app.example", "/OpenSesame/"),
      ).toBeUndefined();
    }
    for (const candidate of ["/..//evil.com", "/a/..//evil.com"]) {
      expect(
        assertSafeReturnTo(candidate, "https://app.example", "/"),
      ).toBeUndefined();
    }
  });

  it("OIDC-RETURN: dot segments cannot climb out of the base path", () => {
    expect(
      assertSafeReturnTo(
        "/OpenSesame/../other",
        "https://app.example",
        "/OpenSesame/",
      ),
    ).toBeUndefined();
    expect(
      assertSafeReturnTo(
        "/OpenSesame/a/../settings",
        "https://app.example",
        "/OpenSesame/",
      ),
    ).toBe("/OpenSesame/settings");
  });
});
