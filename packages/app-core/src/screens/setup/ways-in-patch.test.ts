import { describe, expect, it } from "vitest";
import { loadSettings } from "../../lib/settings.js";
import { applyWaysInPatch } from "./ways-in-patch.js";

const idp = {
  providerId: "okta",
  issuer: "https://example.okta.com",
  clientId: "client",
  label: "Okta",
};

describe("applyWaysInPatch", () => {
  it("changes only what the patch names", () => {
    const current = loadSettings();
    const next = applyWaysInPatch(current, { identityApi: "https://id.x" });
    expect(next.identityApi).toBe("https://id.x");
    expect(next.hostApi).toBe(current.hostApi);
    expect(next.signIn).toEqual({
      builtin: true,
      providers: [],
    });
  });

  it("keeps the live providers when only the built-in road changes", () => {
    const withIdp = applyWaysInPatch(loadSettings(), { providers: [idp] });
    const next = applyWaysInPatch(withIdp, { builtin: false });
    expect(next.signIn).toEqual({ builtin: false, providers: [idp] });
  });
});
