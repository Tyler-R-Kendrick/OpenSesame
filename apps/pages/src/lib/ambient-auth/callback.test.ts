import { describe, expect, it } from "vitest";
import { assertSafeReturnTo } from "./callback.js";

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
});
