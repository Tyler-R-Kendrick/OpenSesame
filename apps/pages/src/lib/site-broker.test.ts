import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDomainRule,
  approveConsent,
  buildErrorMessage,
  buildSuccessMessage,
  brokerAuthorizeUrl,
  consentCovers,
  CONSENTS_KEY,
  deliverToRp,
  loadBrokerPolicy,
  loadConsents,
  normalizeDomainEntry,
  originMatchesDomainEntry,
  originMayUseBroker,
  parseBrokerRequest,
  POLICY_KEY,
  removeDomainRule,
  revokeConsent,
  scriptTagSrc,
  setDomainRuleEffect,
  staticSiteExplicitSnippet,
  staticSiteSnippet,
} from "./site-broker.js";
import { kvDelete } from "./kv.js";

afterEach(() => {
  kvDelete(CONSENTS_KEY);
  kvDelete(POLICY_KEY);
});

describe("parseBrokerRequest", () => {
  it("accepts a well-formed origin-profile request", () => {
    const state = "abcdefghijklmnopqrstuv";
    const result = parseBrokerRequest(
      `client_id=${encodeURIComponent("origin:http://localhost:5173")}&origin=${encodeURIComponent("http://localhost:5173")}&state=${state}&scope=openid%20email`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.origin).toBe("http://localhost:5173");
    expect(result.request.clientId).toBe("origin:http://localhost:5173");
    expect(result.request.scope).toBe("openid email");
  });

  it("rejects client_id that does not match origin", () => {
    const result = parseBrokerRequest(
      "client_id=origin:https://evil.example&origin=http://localhost:5173&state=abcdefghijklmnopqrstuv",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("origin_mismatch");
  });

  it("rejects origin with a path", () => {
    const result = parseBrokerRequest(
      "client_id=origin:http://localhost:5173/app&origin=http://localhost:5173/app&state=abcdefghijklmnopqrstuv",
    );
    expect(result.ok).toBe(false);
  });
});

describe("consent", () => {
  it("remembers and widens scopes", () => {
    approveConsent("http://localhost:5173", "openid");
    expect(consentCovers(loadConsents()[0] ?? null, "openid")).toBe(true);
    expect(consentCovers(loadConsents()[0] ?? null, "openid email")).toBe(
      false,
    );

    approveConsent("http://localhost:5173", "openid email");
    const consent = loadConsents().find(
      (c) => c.origin === "http://localhost:5173",
    );
    expect(consentCovers(consent ?? null, "openid email")).toBe(true);
    expect(consent?.scopes).toEqual(
      expect.arrayContaining(["openid", "email"]),
    );
  });

  it("revokes an origin", () => {
    approveConsent("http://localhost:5173", "openid");
    revokeConsent("http://localhost:5173");
    expect(loadConsents()).toEqual([]);
  });
});

describe("domain rules", () => {
  it("defaults to open (no rules)", () => {
    expect(loadBrokerPolicy()).toEqual({ rules: [] });
    expect(originMayUseBroker("http://localhost:9999")).toBe(true);
  });

  it("normalises and matches host, subdomain, and origin entries", () => {
    expect(normalizeDomainEntry("Example.COM")).toBe("example.com");
    expect(normalizeDomainEntry("https://App.Example.com/")).toBe(
      "https://app.example.com",
    );
    expect(originMatchesDomainEntry("https://foo.example.com", "example.com")).toBe(
      true,
    );
    expect(originMatchesDomainEntry("https://evil.com", "example.com")).toBe(
      false,
    );
    expect(
      originMatchesDomainEntry("http://localhost:5173", "localhost:5173"),
    ).toBe(true);
  });

  it("uses per-row whitelist and blacklist toggles", () => {
    addDomainRule("example.com", "whitelist");
    expect(originMayUseBroker("https://app.example.com")).toBe(true);
    expect(originMayUseBroker("https://other.test")).toBe(false);

    addDomainRule("evil.example.com", "blacklist");
    expect(originMayUseBroker("https://evil.example.com")).toBe(false);
    expect(originMayUseBroker("https://ok.example.com")).toBe(true);

    setDomainRuleEffect("example.com", "blacklist");
    expect(originMayUseBroker("https://ok.example.com")).toBe(false);

    removeDomainRule("example.com");
    removeDomainRule("evil.example.com");
    expect(originMayUseBroker("https://ok.example.com")).toBe(true);
  });

  it("rejects bad domain entries on add", () => {
    const result = addDomainRule("not a domain/path");
    expect(result).toEqual(
      expect.objectContaining({ error: expect.any(String) }),
    );
  });
});

describe("messages and snippets", () => {
  it("builds a success envelope for the RP", () => {
    const message = buildSuccessMessage(
      {
        clientId: "origin:http://localhost:5173",
        origin: "http://localhost:5173",
        state: "abc",
        scope: "openid",
      },
      {
        issuer: "https://shoo.dev",
        upstreamId: "shoo",
        idToken: "header.payload.sig",
        pairwiseSub: "pair-1",
        audience: "origin:https://pages.example",
        jwksUri: "https://shoo.dev/.well-known/jwks.json",
        expiresAt: Date.parse("2026-08-16T12:00:00.000Z"),
      },
    );
    expect(message.type).toBe("opensesame:signin");
    expect(message.id_token).toBe("header.payload.sig");
    expect(message.issuer).toBe("https://shoo.dev");
    expect(message.expires_at).toBe("2026-08-16T12:00:00.000Z");
  });

  it("builds an error envelope", () => {
    const message = buildErrorMessage("st", "consent_denied", "nope");
    expect(message.error).toBe("consent_denied");
    expect(message.error_description).toBe("nope");
  });

  it("emits a declarative snippet and an explicit escape hatch", () => {
    const base = "https://tyler-r-kendrick.github.io/OpenSesame/";
    expect(scriptTagSrc(base)).toBe(
      "https://tyler-r-kendrick.github.io/OpenSesame/auth.js",
    );
    expect(brokerAuthorizeUrl({ origin: "http://localhost:5173", state: "x" }, base)).toContain(
      "/broker/authorize",
    );
    const snippet = staticSiteSnippet({
      brokerBase: base,
      siteOrigin: "http://localhost:5173",
    });
    expect(snippet).toContain("auth.js");
    expect(snippet).toContain("data-opensesame-signin");
    expect(snippet).toContain("opensesame:signed_in");
    expect(snippet).not.toContain("getElementById");

    const explicit = staticSiteExplicitSnippet({
      brokerBase: base,
      siteOrigin: "http://localhost:5173",
    });
    expect(explicit).toContain("OpenSesame.signInAndAccept");
    expect(explicit).toContain('id="opensesame-signin"');
  });
});

describe("deliverToRp", () => {
  it("postMessages to the target origin and never uses *", () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("window", {
      opener: { closed: false, postMessage },
      close,
    });

    const via = deliverToRp(
      {
        type: "opensesame:signin",
        state: "s",
        id_token: "t",
        issuer: "https://shoo.dev",
        audience: "origin:https://pages.example",
        jwks_uri: "https://shoo.dev/.well-known/jwks.json",
        expires_at: "2026-08-16T12:00:00.000Z",
      },
      "http://localhost:5173",
    );

    expect(via).toBe("postMessage");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "opensesame:signin" }),
      "http://localhost:5173",
    );
    expect(postMessage.mock.calls[0]?.[1]).not.toBe("*");
    vi.unstubAllGlobals();
  });
});
