import { describe, expect, it } from "vitest";
import {
  assertSafeReturnTo,
  parseAuthCallback,
} from "./federation-callback.js";

describe("parseAuthCallback error descriptions", () => {
  it("strips spliced tags so no live markup survives sanitization", () => {
    const spliced = encodeURIComponent("<scr<script>ipt>alert</script>");
    const parsed = parseAuthCallback(
      `?error=access_denied&error_description=${spliced}`,
    );
    expect(parsed.kind).toBe("error");
    if (parsed.kind !== "error") return;
    expect(parsed.description).toBe("iptalert");
    expect(parsed.description).not.toContain("<script");
    expect(parsed.description).not.toContain("<");
    expect(parsed.description).not.toContain(">");
  });
});

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
