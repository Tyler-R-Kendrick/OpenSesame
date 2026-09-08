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
});
