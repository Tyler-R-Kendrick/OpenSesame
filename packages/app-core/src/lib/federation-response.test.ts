/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { hasAuthResponse } from "./federation.js";

describe("hasAuthResponse", () => {
  it("detects code or error query parameters", () => {
    expect(hasAuthResponse("?code=abc&state=xyz")).toBe(true);
    expect(hasAuthResponse("?error=access_denied")).toBe(true);
    expect(hasAuthResponse("?foo=bar")).toBe(false);
    expect(hasAuthResponse("")).toBe(false);
  });

  it("ignores GitHub App Manifest landings that also carry a code", () => {
    expect(
      hasAuthResponse(
        "?github_app=claim&github_app_code=abc&github_app_state=xyz",
      ),
    ).toBe(false);
    expect(hasAuthResponse("?github_app=claim&code=abc&state=xyz")).toBe(false);
    expect(hasAuthResponse("?github_app_code=abc&github_app_state=xyz")).toBe(
      false,
    );
  });
});
