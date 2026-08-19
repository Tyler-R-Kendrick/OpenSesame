import { afterEach, describe, expect, it, vi } from "vitest";
import { kvDelete } from "./kv.js";
import {
  CONSENTS_KEY,
  POLICY_KEY,
  addDomainRule,
  approveConsent,
  brokerAuthorizeUrl,
  buildErrorMessage,
  buildSuccessMessage,
  consentCovers,
  deliverToRp,
  isBrokerRestricted,
  loadBrokerPolicy,
  loadConsents,
  normalizeDomainEntry,
  originMatchesDomainEntry,
  originMayUseBroker,
  parseBrokerRequest,
  removeDomainRule,
  revokeConsent,
  scriptTagSrc,
  setDomainRuleEffect,
  staticSiteExplicitSnippet,
  staticSiteSnippet,
} from "./site-broker.js";

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
  it("defaults to public (no rules)", () => {
    expect(loadBrokerPolicy()).toEqual({ rules: [] });
    expect(isBrokerRestricted()).toBe(false);
    expect(originMayUseBroker("http://localhost:9999")).toBe(true);
  });

  it("stays public with only blocked domains", () => {
    addDomainRule("evil.test", "blacklist");
    expect(isBrokerRestricted()).toBe(false);
    expect(originMayUseBroker("https://ok.test")).toBe(true);
    expect(originMayUseBroker("https://evil.test")).toBe(false);
  });

  it("becomes restricted when the first allowed domain is added", () => {
    addDomainRule("example.com", "whitelist");
    expect(isBrokerRestricted()).toBe(true);
    expect(originMayUseBroker("https://app.example.com")).toBe(true);
    expect(originMayUseBroker("https://other.test")).toBe(false);
  });

  it("normalises and matches host, subdomain, and origin entries", () => {
    expect(normalizeDomainEntry("Example.COM")).toBe("example.com");
    expect(normalizeDomainEntry("https://App.Example.com/")).toBe(
      "https://app.example.com",
    );
    expect(
      originMatchesDomainEntry("https://foo.example.com", "example.com"),
    ).toBe(true);
    expect(originMatchesDomainEntry("https://evil.com", "example.com")).toBe(
      false,
    );
    expect(
      originMatchesDomainEntry("http://localhost:5173", "localhost:5173"),
    ).toBe(true);
  });

  it("uses per-row allow and block effects", () => {
    addDomainRule("example.com", "whitelist");
    expect(originMayUseBroker("https://app.example.com")).toBe(true);
    expect(originMayUseBroker("https://other.test")).toBe(false);

    addDomainRule("evil.example.com", "blacklist");
    expect(originMayUseBroker("https://evil.example.com")).toBe(false);
    expect(originMayUseBroker("https://ok.example.com")).toBe(true);

    setDomainRuleEffect("example.com", "blacklist");
    expect(originMayUseBroker("https://ok.example.com")).toBe(false);
    expect(isBrokerRestricted()).toBe(false);

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
    expect(
      brokerAuthorizeUrl({ origin: "http://localhost:5173", state: "x" }, base),
    ).toContain("/broker/authorize");
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

describe("parseBrokerRequest validation", () => {
  it("requires client_id, origin, and state", () => {
    const result = parseBrokerRequest("client_id=&origin=&state=");
    expect(result).toMatchObject({ ok: false, error: "invalid_request" });
    expect(parseBrokerRequest("")).toMatchObject({
      ok: false,
      error: "invalid_request",
    });
  });

  it("rejects an origin that is not an absolute URL", () => {
    const result = parseBrokerRequest(
      "client_id=origin%3Anotaurl&origin=notaurl&state=abcdefghijklmnopqrstuv",
    );
    expect(result).toMatchObject({
      ok: false,
      detail: "origin must be an absolute URL origin.",
    });
  });

  it("rejects weak state entropy", () => {
    // 21 base64url chars decode to 15 bytes — under the 16-byte floor.
    const weak = parseBrokerRequest(
      `client_id=${encodeURIComponent("origin:http://localhost:5173")}&origin=${encodeURIComponent("http://localhost:5173")}&state=AAAAAAAAAAAAAAAAAAAAA`,
    );
    expect(weak).toMatchObject({
      ok: false,
      detail: "state must carry at least 16 bytes of entropy.",
    });
    // Not even valid base64.
    const garbage = parseBrokerRequest(
      `client_id=${encodeURIComponent("origin:http://localhost:5173")}&origin=${encodeURIComponent("http://localhost:5173")}&state=short!!!`,
    );
    expect(garbage).toMatchObject({ ok: false, error: "invalid_request" });
  });

  it("defaults a blank scope to openid and collapses whitespace", () => {
    const result = parseBrokerRequest(
      `client_id=${encodeURIComponent("origin:http://localhost:5173")}&origin=${encodeURIComponent("http://localhost:5173")}&state=abcdefghijklmnopqrstuv&scope=${encodeURIComponent("  ")}`,
    );
    expect(result.ok && result.request.scope).toBe("openid");
  });
});

describe("consent storage edges", () => {
  it("reads corrupt or shapeless consent payloads as empty", async () => {
    const { kvSet } = await import("./kv.js");
    const { scopedKey } = await import("./projects.js");
    kvSet(scopedKey(CONSENTS_KEY), "{corrupt");
    expect(loadConsents()).toEqual([]);
    kvSet(scopedKey(CONSENTS_KEY), JSON.stringify({ consents: "nope" }));
    expect(loadConsents()).toEqual([]);
  });

  it("treats missing consent as covering nothing", () => {
    expect(consentCovers(null, "openid")).toBe(false);
  });

  it("keeps the original approval time when scopes widen", () => {
    const first = approveConsent("http://localhost:5173", "openid");
    const second = approveConsent("http://localhost:5173", "email");
    expect(second.approvedAt).toBe(first.approvedAt);
    expect(second.scopes).toEqual(["openid", "email"]);
  });

  it("touches lastUsedAt only for known origins", async () => {
    const { touchConsent } = await import("./site-broker.js");
    touchConsent("http://unknown.example");
    expect(loadConsents()).toEqual([]);
    const approved = approveConsent("http://localhost:5173", "openid");
    touchConsent("http://localhost:5173");
    const touched = loadConsents()[0];
    expect(Date.parse(touched?.lastUsedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(approved.lastUsedAt),
    );
  });

  it("keeps remaining consents when one origin is revoked", () => {
    approveConsent("http://a.example", "openid");
    approveConsent("http://b.example", "openid");
    revokeConsent("http://a.example");
    expect(loadConsents().map((c) => c.origin)).toEqual(["http://b.example"]);
  });
});

describe("broker policy storage and normalization", () => {
  it("migrates the legacy listMode + domains shape", async () => {
    const { kvSet } = await import("./kv.js");
    const { scopedKey } = await import("./projects.js");
    kvSet(
      scopedKey(POLICY_KEY),
      JSON.stringify({
        listMode: "allowlist",
        domains: ["Example.com", 42, "bad/domain"],
      }),
    );
    expect(loadBrokerPolicy()).toEqual({
      rules: [{ domain: "example.com", effect: "whitelist" }],
    });

    kvSet(
      scopedKey(POLICY_KEY),
      JSON.stringify({ listMode: "blocklist", domains: ["evil.test"] }),
    );
    expect(loadBrokerPolicy()).toEqual({
      rules: [{ domain: "evil.test", effect: "blacklist" }],
    });
  });

  it("drops malformed rule rows and defaults effect to whitelist", async () => {
    const { kvSet } = await import("./kv.js");
    const { scopedKey } = await import("./projects.js");
    kvSet(
      scopedKey(POLICY_KEY),
      JSON.stringify({
        rules: [
          null,
          "junk",
          { domain: 42 },
          { domain: "ok.test" },
          { domain: "bad.test", effect: "blacklist" },
        ],
      }),
    );
    expect(loadBrokerPolicy()).toEqual({
      rules: [
        { domain: "bad.test", effect: "blacklist" },
        { domain: "ok.test", effect: "whitelist" },
      ],
    });
  });

  it("reads corrupt and shapeless policy payloads as empty", async () => {
    const { kvSet } = await import("./kv.js");
    const { scopedKey } = await import("./projects.js");
    kvSet(scopedKey(POLICY_KEY), "{corrupt");
    expect(loadBrokerPolicy()).toEqual({ rules: [] });
    kvSet(scopedKey(POLICY_KEY), JSON.stringify({ other: true }));
    expect(loadBrokerPolicy()).toEqual({ rules: [] });
  });

  it("normalizes only useful domain entries", () => {
    expect(normalizeDomainEntry("")).toBeNull();
    expect(normalizeDomainEntry("https://app.example.com/path")).toBeNull();
    expect(normalizeDomainEntry("https://app.example.com/?q=1")).toBeNull();
    expect(normalizeDomainEntry("https://app.example.com/#f")).toBeNull();
    expect(normalizeDomainEntry("foo://[")).toBeNull();
    expect(normalizeDomainEntry("host/extra")).toBeNull();
    expect(normalizeDomainEntry(".lead")).toBeNull();
    expect(normalizeDomainEntry("trail.")).toBeNull();
    expect(normalizeDomainEntry("host?x")).toBeNull();
    expect(normalizeDomainEntry("localhost:5173")).toBe("localhost:5173");
  });

  it("matches exact origins and reports match scores", async () => {
    const { domainMatchScore } = await import("./site-broker.js");
    expect(
      originMatchesDomainEntry(
        "https://app.example.com",
        "https://app.example.com",
      ),
    ).toBe(true);
    expect(
      originMatchesDomainEntry(
        "https://app.example.com",
        "https://other.example.com",
      ),
    ).toBe(false);
    expect(originMatchesDomainEntry("::not a url", "example.com")).toBe(false);
    expect(originMatchesDomainEntry("https://x.example", "bad/entry")).toBe(
      false,
    );

    expect(domainMatchScore("https://x.example", "example.com")).toBe(0);
    const exact = domainMatchScore(
      "https://app.example.com",
      "https://app.example.com",
    );
    const hostPort = domainMatchScore(
      "http://localhost:5173",
      "localhost:5173",
    );
    const bare = domainMatchScore("https://example.com", "example.com");
    const sub = domainMatchScore("https://app.example.com", "example.com");
    expect(exact).toBeGreaterThan(1000);
    expect(hostPort).toBeGreaterThan(500);
    expect(hostPort).toBeLessThan(1000);
    expect(bare).toBeGreaterThan(100);
    expect(bare).toBeLessThan(500);
    expect(sub).toBeGreaterThan(50);
    expect(sub).toBeLessThan(100);
  });

  it("explains denials for blocked and unlisted origins", async () => {
    const { domainFilterDenialMessage } = await import("./site-broker.js");
    addDomainRule("evil.test", "blacklist");
    expect(domainFilterDenialMessage("https://evil.test")).toMatch(
      /blocked domain \(evil\.test\)/,
    );
    addDomainRule("example.com", "whitelist");
    expect(domainFilterDenialMessage("https://other.test")).toMatch(
      /not on the allow list/,
    );
  });
});

describe("deliverToRp fallbacks", () => {
  const successMessage = {
    type: "opensesame:signin" as const,
    state: "s",
    id_token: "t",
    issuer: "https://shoo.dev",
    audience: "origin:https://pages.example",
    jwks_uri: "https://shoo.dev/.well-known/jwks.json",
    expires_at: "2026-08-16T12:00:00.000Z",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips window.close when asked not to", () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    vi.stubGlobal("window", {
      opener: { closed: false, postMessage },
      close,
    });
    const via = deliverToRp(successMessage, "http://localhost:5173", {
      close: false,
    });
    expect(via).toBe("postMessage");
    expect(close).not.toHaveBeenCalled();
  });

  it("retries postMessage when reading the opener throws", () => {
    const postMessage = vi.fn();
    let reads = 0;
    const opener = {
      postMessage,
      get closed(): boolean {
        reads += 1;
        if (reads === 1) throw new Error("cross-origin");
        return false;
      },
    };
    vi.stubGlobal("window", { opener, close: vi.fn() });
    const via = deliverToRp(successMessage, "http://localhost:5173");
    expect(via).toBe("postMessage");
    expect(postMessage).toHaveBeenCalledOnce();
  });

  it("falls back to a fragment redirect on the same origin", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    vi.stubGlobal("location", { assign });

    const via = deliverToRp(successMessage, "http://localhost:5173", {
      redirectUri: "http://localhost:5173/callback",
    });

    expect(via).toBe("fragment");
    const target = String(assign.mock.calls[0]?.[0]);
    expect(target.startsWith("http://localhost:5173/callback#")).toBe(true);
    expect(target).toContain("id_token=t");
  });

  it("refuses a fragment redirect to a different origin", () => {
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    const via = deliverToRp(successMessage, "http://localhost:5173", {
      redirectUri: "https://evil.example/callback",
    });
    expect(via).toBe("none");
  });

  it("refuses an unparseable redirect URI", () => {
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    const via = deliverToRp(successMessage, "http://localhost:5173", {
      redirectUri: "::nope::",
    });
    expect(via).toBe("none");
  });

  it("reports none when the opener is gone and no redirect was given", () => {
    vi.stubGlobal("window", { opener: { closed: true }, close: vi.fn() });
    expect(deliverToRp(successMessage, "http://localhost:5173")).toBe("none");
    vi.stubGlobal("window", { opener: null, close: vi.fn() });
    expect(deliverToRp(successMessage, "http://localhost:5173")).toBe("none");
  });
});
