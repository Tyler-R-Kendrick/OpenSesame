import { describe, expect, it } from "vitest";
import {
  capabilitiesForProtocol,
  domainOnlyBrokerHint,
  normalizePrompt,
  protocolForIssuer,
  supportsCapability,
} from "./provider.js";

describe("provider capabilities", () => {
  it("PROVIDER-SHOO: automatic acquisition is unsupported", () => {
    expect(
      supportsCapability(
        { capabilities: capabilitiesForProtocol("shoo") },
        "silent-redirect",
      ),
    ).toBe(false);
    expect(
      supportsCapability(
        { capabilities: capabilitiesForProtocol("shoo") },
        "silent-iframe",
      ),
    ).toBe(false);
    const prompt = normalizePrompt({
      intent: {
        kind: "ambient",
        policyRevision: "r",
        selectedProviderKey: "shoo|https://shoo.dev|origin:x|",
      },
      protocol: "shoo",
    });
    expect(prompt).toEqual({ ok: false, reason: "unsupported" });
  });

  it("never combines none with login", () => {
    const ambient = normalizePrompt({
      intent: {
        kind: "ambient",
        policyRevision: "r",
        selectedProviderKey: "k",
      },
      transport: "silent-redirect",
      protocol: "oidc",
    });
    expect(ambient).toEqual({ ok: true, prompt: { prompt: "none" } });
    const reauth = normalizePrompt({
      intent: {
        kind: "reauthenticate",
        expectedAccountKey: "a",
        reason: "step-up",
      },
      protocol: "oidc",
    });
    expect(reauth).toEqual({ ok: true, prompt: { prompt: "login" } });
    const select = normalizePrompt({
      intent: { kind: "switch-account" },
      protocol: "oidc",
    });
    expect(select).toEqual({ ok: true, prompt: { prompt: "select_account" } });
  });

  it("keeps loginHint domain-only", () => {
    expect(domainOnlyBrokerHint("contoso.com")).toBe("contoso.com");
    expect(domainOnlyBrokerHint("pat@contoso.com")).toBeUndefined();
    expect(domainOnlyBrokerHint("not a domain")).toBeUndefined();
  });

  it("does not infer FedCM from Google branding", () => {
    expect(protocolForIssuer("https://accounts.google.com", "google")).toBe(
      "oidc",
    );
    expect(capabilitiesForProtocol("oidc")).not.toContain("fedcm-auto");
  });
});
