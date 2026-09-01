import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FederationError,
  TRUSTED_UPSTREAMS,
  adoptBrokeredSession,
  beginSignIn,
  clearAuthResponseFromUrl,
  clearSession,
  completeSignIn,
  decodeJwtClaims,
  defaultUpstream,
  derivedSubjectFor,
  discover,
  displayName,
  hasAuthResponse,
  isBrokeredIssuer,
  isOperatorIdpIssuer,
  loadSession,
  operatorUpstream,
  originClientId,
  redirectUri,
  saveSession,
  upstreamByIssuer,
} from "./federation.js";
import type { UpstreamIdentity } from "./federation.js";
import { identitySeams } from "./identity.js";
import {
  brokeredRealmUpstream,
  brokeredUpstream,
  workEmailDomain,
} from "./providers.js";
import { settingsSeams } from "./settings.js";

const originalSettingsSeams = { ...settingsSeams };

const PKCE_KEY = "opensesame:federation:pkce";
const SESSION_KEY = "opensesame:federation:session";

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(claims: JsonObject): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims),
  )}.signature`;
}

function seedPending(overrides: JsonObject = {}): void {
  localStorage.setItem(
    PKCE_KEY,
    JSON.stringify({
      upstreamId: "mock",
      issuer: "http://127.0.0.1:9090",
      verifier: "verifier-1",
      state: "state-1",
      tokenEndpoint: "http://127.0.0.1:9090/token",
      jwksUri: "http://127.0.0.1:9090/jwks",
      scope: "openid",
      ...overrides,
    }),
  );
}

/** The pending record, wherever the current build keeps it. */
function storedPending(): JsonObject {
  return JSON.parse(localStorage.getItem(PKCE_KEY) ?? "null");
}

function identity(overrides: Partial<UpstreamIdentity> = {}): UpstreamIdentity {
  return {
    issuer: "https://shoo.dev",
    upstreamId: "shoo",
    idToken: "token",
    pairwiseSub: "pairwise-1",
    audience: originClientId(),
    jwksUri: "https://shoo.dev/jwks",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trusted upstreams", () => {
  it("picks Shoo as the compiled-in broker on every origin", () => {
    expect(defaultUpstream().id).toBe("shoo");
    expect(defaultUpstream().authorizationEndpoint).toBe(
      "https://shoo.dev/authorize",
    );
  });

  it("looks upstreams up by exact issuer", () => {
    expect(upstreamByIssuer("https://shoo.dev")?.displayName).toBe("Shoo");
    expect(upstreamByIssuer("https://unknown.example")).toBeUndefined();
  });

  it("derives the origin client id and redirect URI from this origin", () => {
    expect(originClientId()).toBe(`origin:${location.origin}`);
    expect(originClientId("https://rp.example")).toBe(
      "origin:https://rp.example",
    );
    expect(redirectUri()).toBe(`${location.origin}/`);
  });
});

describe("decodeJwtClaims", () => {
  it("parses the payload of a well-formed token", () => {
    expect(decodeJwtClaims(jwt({ sub: "abc" }))).toEqual({ sub: "abc" });
  });

  it("rejects input that is not a JWT", () => {
    expect(() => decodeJwtClaims("not-a-jwt")).toThrowError(FederationError);
    expect(() => decodeJwtClaims("not-a-jwt")).toThrowError(/Not a JWT/);
  });

  it("rejects a token whose payload is not JSON", () => {
    expect(() => decodeJwtClaims(`a.${b64url("<<not json>>")}.c`)).toThrowError(
      /not JSON/,
    );
  });
});

describe("derivedSubjectFor", () => {
  it("matches a base64url SHA-256 of sub and origin", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("sub-1:https://rp.example"),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await expect(
      derivedSubjectFor("sub-1", "https://rp.example"),
    ).resolves.toBe(expected);
  });
});

describe("discover", () => {
  const doc = {
    issuer: "http://127.0.0.1:9090",
    authorization_endpoint: "http://127.0.0.1:9090/authorize",
    token_endpoint: "http://127.0.0.1:9090/token",
    jwks_uri: "http://127.0.0.1:9090/jwks",
  };

  function stubDiscovery(body: BoundaryValue, status = 200) {
    const spy = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("loads and returns the discovery document", async () => {
    const spy = stubDiscovery(doc);
    const result = await discover("http://127.0.0.1:9090/");
    expect(result.token_endpoint).toBe(doc.token_endpoint);
    expect(result.issuer).toBe("http://127.0.0.1:9090/");
    expect(String(spy.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:9090/.well-known/openid-configuration",
    );
  });

  it("reports an unreachable upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("failed to fetch"))),
    );
    await expect(discover("http://127.0.0.1:9090")).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("reports a non-OK discovery response", async () => {
    stubDiscovery({}, 500);
    await expect(discover("http://127.0.0.1:9090")).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
    await expect(discover("http://127.0.0.1:9090")).rejects.toThrowError(
      /returned 500/,
    );
  });

  it("rejects an incomplete discovery document", async () => {
    stubDiscovery({ issuer: "http://127.0.0.1:9090" });
    await expect(discover("http://127.0.0.1:9090")).rejects.toThrowError(
      /incomplete discovery document/,
    );
  });

  it("rejects a document issued for someone else", async () => {
    stubDiscovery({ ...doc, issuer: "https://evil.example" });
    await expect(discover("http://127.0.0.1:9090")).rejects.toMatchObject({
      code: "issuer_mismatch",
    });
  });
});

describe("beginSignIn", () => {
  it("stores PKCE state for the round trip and navigates upstream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            issuer: "http://127.0.0.1:9090",
            authorization_endpoint: "http://127.0.0.1:9090/authorize",
            token_endpoint: "http://127.0.0.1:9090/token",
            jwks_uri: "http://127.0.0.1:9090/jwks",
          }),
        ),
      ),
    );
    const upstream = TRUSTED_UPSTREAMS.find((u) => u.id === "mock");
    if (!upstream) throw new Error("mock upstream missing");

    await beginSignIn(upstream, { scope: "openid email", returnTo: "/access" });

    const pending = storedPending();
    expect(pending).toMatchObject({
      upstreamId: "mock",
      issuer: "http://127.0.0.1:9090",
      scope: "openid email",
      returnTo: "/access",
      tokenEndpoint: "http://127.0.0.1:9090/token",
      jwksUri: "http://127.0.0.1:9090/jwks",
    });
    expect(pending.verifier).toBeTruthy();
    expect(pending.state).toBeTruthy();
  });

  it("does not fetch discovery for a compiled broker that already has endpoints", async () => {
    const fetchMock = vi.fn(() =>
      Promise.reject(new Error("discovery must not run")),
    );
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    vi.stubGlobal("location", {
      origin: window.location.origin,
      hostname: window.location.hostname,
      href: window.location.href,
      search: window.location.search,
      assign: (url: string) => {
        seen.push(url);
      },
    });
    const upstream = TRUSTED_UPSTREAMS.find((u) => u.id === "shoo");
    if (!upstream) throw new Error("shoo upstream missing");

    await beginSignIn(upstream);

    expect(fetchMock).not.toHaveBeenCalled();
    const pending = storedPending();
    expect(pending.tokenEndpoint).toBe("https://shoo.dev/token");
    expect(pending.sessionCheckEndpoint).toBe("https://shoo.dev/session/check");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith("https://shoo.dev/authorize?")).toBe(true);
    expect(seen[0]).toContain(
      `client_id=${encodeURIComponent(`origin:${window.location.origin}`)}`,
    );
  });

  it("speaks Shoo's authorize dialect, not generic OIDC", async () => {
    const seen: string[] = [];
    vi.stubGlobal("location", {
      origin: window.location.origin,
      hostname: window.location.hostname,
      href: window.location.href,
      search: window.location.search,
      assign: (url: string) => {
        seen.push(url);
      },
    });
    const upstream = TRUSTED_UPSTREAMS.find((u) => u.id === "shoo");
    if (!upstream) throw new Error("shoo upstream missing");

    await beginSignIn(upstream);

    // Exactly what shoo.js sends (docs.shoo.dev): client, redirect, state and
    // an S256 challenge. `response_type` and `scope` are not part of Shoo's
    // protocol, and profile data is the `pii` flag — absent unless asked for.
    const url = new URL(seen[0] ?? "");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri());
    expect(url.searchParams.get("response_type")).toBeNull();
    expect(url.searchParams.get("scope")).toBeNull();
    expect(url.searchParams.get("pii")).toBeNull();
  });

  it("asks Shoo for PII when the caller wants profile data", async () => {
    const seen: string[] = [];
    vi.stubGlobal("location", {
      origin: window.location.origin,
      hostname: window.location.hostname,
      href: window.location.href,
      search: window.location.search,
      assign: (url: string) => {
        seen.push(url);
      },
    });
    const upstream = TRUSTED_UPSTREAMS.find((u) => u.id === "shoo");
    if (!upstream) throw new Error("shoo upstream missing");

    await beginSignIn(upstream, { scope: "openid profile email" });

    const url = new URL(seen[0] ?? "");
    expect(url.searchParams.get("pii")).toBe("true");
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("stores org tenant metadata for an SSO/SAML round trip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            issuer: "https://idp.acme.example",
            authorization_endpoint: "https://idp.acme.example/authorize",
            token_endpoint: "https://idp.acme.example/token",
            jwks_uri: "https://idp.acme.example/jwks",
          }),
        ),
      ),
    );
    await beginSignIn(
      {
        id: "org:acme:sso",
        displayName: "Acme",
        issuer: "https://idp.acme.example",
        accountKind: "SSO",
      },
      { orgSlug: "acme", orgMethod: "sso", returnTo: "/vault" },
    );
    const pending = storedPending();
    expect(pending).toMatchObject({
      orgSlug: "acme",
      orgMethod: "sso",
      issuer: "https://idp.acme.example",
      returnTo: "/vault",
    });
  });
});

describe("hasAuthResponse", () => {
  it("detects code or error query parameters", () => {
    expect(hasAuthResponse("?code=abc&state=xyz")).toBe(true);
    expect(hasAuthResponse("?error=access_denied")).toBe(true);
    expect(hasAuthResponse("?foo=bar")).toBe(false);
    expect(hasAuthResponse("")).toBe(false);
  });
});

describe("completeSignIn", () => {
  function stubTokenResponse(body: BoundaryValue, status = 200) {
    return vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
  }

  it("returns null when this load is not an upstream response", async () => {
    await expect(completeSignIn()).resolves.toBeNull();
  });

  it("surfaces an upstream error with its description", async () => {
    history.replaceState(
      null,
      "",
      "/?error=access_denied&error_description=No+way",
    );
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "access_denied",
      message: "No way",
    });
  });

  it("falls back to a generic message for an undescribed error", async () => {
    history.replaceState(null, "", "/?error=server_error");
    await expect(completeSignIn()).rejects.toThrowError(/server_error/);
  });

  it("refuses a code when no sign-in is in progress", async () => {
    history.replaceState(null, "", "/?code=abc&state=state-1");
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("treats a replayed callback as a non-event when already signed in", async () => {
    // The callback URL reopened from history after a finished sign-in: the
    // pending record is spent, but the person IS signed in. Erroring here sent
    // them back to the sign-in screen in a loop.
    saveSession(identity());
    history.replaceState(null, "", "/?code=spent&state=old-state");
    await expect(completeSignIn()).resolves.toBeNull();
    expect(location.search).toBe("");
    expect(loadSession()?.pairwiseSub).toBe("pairwise-1");
  });

  it("refuses a pending record older than Shoo's ten-minute PKCE ceiling", async () => {
    seedPending({ createdAt: Date.now() - 11 * 60 * 1000 });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "invalid_request",
    });
    // The stale record is gone either way; a retry starts clean.
    expect(localStorage.getItem(PKCE_KEY)).toBeNull();
  });

  it("finishes a sign-in that an older build left in sessionStorage", async () => {
    localStorage.clear();
    sessionStorage.setItem(
      PKCE_KEY,
      JSON.stringify({
        upstreamId: "mock",
        issuer: "http://127.0.0.1:9090",
        verifier: "verifier-1",
        state: "state-1",
        tokenEndpoint: "http://127.0.0.1:9090/token",
        jwksUri: "http://127.0.0.1:9090/jwks",
        scope: "openid",
      }),
    );
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "http://127.0.0.1:9090",
        aud: originClientId(),
        exp: Date.now() / 1000 + 3600,
        pairwise_sub: "sub-legacy",
      }),
    });
    const result = await completeSignIn();
    expect(result?.identity.pairwiseSub).toBe("sub-legacy");
    expect(sessionStorage.getItem(PKCE_KEY)).toBeNull();
  });

  it("refuses a code when the stored PKCE state is unreadable", async () => {
    localStorage.setItem(PKCE_KEY, "{corrupt");
    history.replaceState(null, "", "/?code=abc&state=state-1");
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  it("refuses a state that does not match the pending request", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=other-state");
    await expect(completeSignIn()).rejects.toThrowError(/state did not match/);
  });

  it("reports an unreachable token endpoint", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("failed to fetch"))),
    );
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "upstream_unavailable",
    });
  });

  it("reports a refused code exchange", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({ error: "invalid_grant" }, 400);
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "exchange_failed",
    });
  });

  it("reports a token response without an id_token", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({ access_token: "only-access" });
    await expect(completeSignIn()).rejects.toThrowError(/no id_token/);
  });

  it("rejects a token from the wrong issuer", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "https://shoo.dev",
        aud: originClientId(),
        exp: Date.now() / 1000 + 3600,
        pairwise_sub: "sub-1",
      }),
    });
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "issuer_mismatch",
    });
  });

  it("rejects a token from an issuer no longer trusted", async () => {
    seedPending({ issuer: "https://evil.example" });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "https://evil.example",
        aud: originClientId(),
        exp: Date.now() / 1000 + 3600,
        pairwise_sub: "sub-1",
      }),
    });
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "untrusted_issuer",
    });
  });

  it("rejects a token minted for a different audience", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "http://127.0.0.1:9090",
        aud: "origin:https://someone-else.example",
        exp: Date.now() / 1000 + 3600,
        pairwise_sub: "sub-1",
      }),
    });
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "audience_mismatch",
    });
  });

  it("accepts an audience list containing this origin", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "http://127.0.0.1:9090",
        aud: ["origin:https://other.example", originClientId()],
        exp: Date.now() / 1000 + 3600,
        pairwise_sub: "sub-1",
      }),
    });
    const result = await completeSignIn();
    expect(result?.identity.pairwiseSub).toBe("sub-1");
  });

  it("rejects an already-expired token", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "http://127.0.0.1:9090",
        aud: originClientId(),
        exp: Date.now() / 1000 - 10,
        pairwise_sub: "sub-1",
      }),
    });
    await expect(completeSignIn()).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects a token without a pairwise subject", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "http://127.0.0.1:9090",
        aud: originClientId(),
        exp: Date.now() / 1000 + 3600,
      }),
    });
    await expect(completeSignIn()).rejects.toThrowError(/pairwise_sub/);
  });

  it("completes the flow, persists the session, and cleans the URL", async () => {
    seedPending({ returnTo: "/broker?x=1" });
    history.replaceState(null, "", "/?code=abc&state=state-1&scope=openid");
    stubTokenResponse({
      id_token: jwt({
        iss: "http://127.0.0.1:9090",
        aud: originClientId(),
        exp: 4_000_000_000,
        pairwise_sub: "sub-1",
        email: "a@example.com",
        name: "Ada",
        picture: "https://img.example/a.png",
      }),
    });

    const result = await completeSignIn();

    expect(result?.returnTo).toBe("/broker?x=1");
    expect(result?.identity).toMatchObject({
      issuer: "http://127.0.0.1:9090",
      upstreamId: "mock",
      pairwiseSub: "sub-1",
      email: "a@example.com",
      name: "Ada",
      picture: "https://img.example/a.png",
      expiresAt: 4_000_000_000_000,
    });
    // The pending PKCE state is single-use.
    expect(localStorage.getItem(PKCE_KEY)).toBeNull();
    expect(sessionStorage.getItem(PKCE_KEY)).toBeNull();
    // The session survives a same-tab reload until it expires.
    expect(loadSession()?.pairwiseSub).toBe("sub-1");
    // The address bar no longer carries a replayable code.
    expect(location.search).toBe("");
  });

  /**
   * "We actually have an authorized user" (docs.shoo.dev/server-verification):
   * Shoo's JWKS serves no CORS, so the ES256 signature cannot be verified in
   * this page — `POST /session/check` is the broker's signature- and
   * revocation-backed answer, and its explicit 401 refuses the sign-in.
   */
  describe("upstream session check", () => {
    const CHECK = "https://shoo.dev/session/check";

    function shooToken(): string {
      return jwt({
        iss: "https://shoo.dev",
        aud: originClientId(),
        exp: 4_000_000_000,
        pairwise_sub: "ps_sub-1",
      });
    }

    function seedShooPending(): void {
      seedPending({
        upstreamId: "shoo",
        issuer: "https://shoo.dev",
        tokenEndpoint: "https://shoo.dev/token",
        jwksUri: "https://shoo.dev/.well-known/jwks.json",
        sessionCheckEndpoint: CHECK,
      });
    }

    function stubExchangeThenCheck(check: () => Response) {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
          const url = String(input);
          calls.push({ url, init });
          if (url === CHECK) return Promise.resolve(check());
          return Promise.resolve(Response.json({ id_token: shooToken() }));
        }),
      );
      return calls;
    }

    it("asks the broker and passes an active session through", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      const calls = stubExchangeThenCheck(() =>
        Response.json({ status: "active" }),
      );

      const result = await completeSignIn();

      expect(result?.identity.pairwiseSub).toBe("ps_sub-1");
      const check = calls.find((call) => call.url === CHECK);
      const headers = new Headers(check?.init.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${shooToken()}`);
      expect(loadSession()?.pairwiseSub).toBe("ps_sub-1");
    });

    it("refuses a sign-in the broker says is revoked, saving nothing", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      stubExchangeThenCheck(
        () =>
          new Response(
            JSON.stringify({ status: "login_required", reason: "revoked" }),
            { status: 401 },
          ),
      );

      await expect(completeSignIn()).rejects.toMatchObject({
        code: "login_required",
      });
      expect(loadSession()).toBeNull();
    });

    it("does not block on a broker without the endpoint", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      stubExchangeThenCheck(() => new Response("not here", { status: 404 }));

      const result = await completeSignIn();
      expect(result?.identity.pairwiseSub).toBe("ps_sub-1");
    });

    it("does not block on a transport failure after a good exchange", async () => {
      seedShooPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === CHECK) {
            return Promise.reject(new TypeError("failed to fetch"));
          }
          return Promise.resolve(Response.json({ id_token: shooToken() }));
        }),
      );

      const result = await completeSignIn();
      expect(result?.identity.pairwiseSub).toBe("ps_sub-1");
    });

    it("never calls a check endpoint an upstream does not declare", async () => {
      seedPending();
      history.replaceState(null, "", "/?code=abc&state=state-1");
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          Response.json({
            id_token: jwt({
              iss: "http://127.0.0.1:9090",
              aud: originClientId(),
              exp: Date.now() / 1000 + 3600,
              pairwise_sub: "sub-1",
            }),
          }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      await completeSignIn();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("accepts an org-tenant issuer that is not a global trusted broker", async () => {
    seedPending({
      issuer: "https://idp.acme.example",
      orgSlug: "acme",
      orgMethod: "saml",
      returnTo: "/settings",
    });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    stubTokenResponse({
      id_token: jwt({
        iss: "https://idp.acme.example",
        aud: originClientId(),
        exp: Date.now() / 1000 + 3600,
        sub: "dir-user-1",
      }),
    });
    const result = await completeSignIn();
    expect(result).toMatchObject({
      orgSlug: "acme",
      orgMethod: "saml",
      returnTo: "/settings",
      identity: { pairwiseSub: "dir-user-1" },
    });
    expect(loadSession()).toBeNull();
  });
});

describe("session storage", () => {
  it("round-trips a live session", () => {
    const value = identity();
    saveSession(value);
    expect(loadSession()).toEqual(value);
  });

  it("returns null when nothing is stored", () => {
    expect(loadSession()).toBeNull();
  });

  it("drops an expired session", () => {
    saveSession(identity({ expiresAt: Date.now() - 1000 }));
    expect(loadSession()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("drops a session whose issuer is no longer trusted", () => {
    saveSession(identity({ issuer: "https://evil.example" }));
    expect(loadSession()).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("ignores a corrupt session payload", () => {
    localStorage.setItem(SESSION_KEY, "{not json");
    expect(loadSession()).toBeNull();
  });

  it("clears the stored session", () => {
    saveSession(identity());
    clearSession();
    expect(loadSession()).toBeNull();
  });
});

describe("displayName", () => {
  it("prefers name, then email, then the pairwise subject", () => {
    expect(displayName(identity({ name: "Ada", email: "a@example.com" }))).toBe(
      "Ada",
    );
    expect(displayName(identity({ email: "a@example.com" }))).toBe(
      "a@example.com",
    );
    expect(displayName(identity())).toBe("pairwise-1");
  });
});

describe("clearAuthResponseFromUrl", () => {
  it("strips only the auth response parameters", () => {
    history.replaceState(
      null,
      "",
      "/?code=abc&state=xyz&error=e&error_description=d&scope=s&keep=1",
    );
    clearAuthResponseFromUrl();
    expect(location.search).toBe("?keep=1");
  });
});

/**
 * Brokered federation (C11/D7/D8): providers whose token endpoint serves no
 * CORS are run by the Identity API on this app's behalf. That makes the
 * configured Identity API a trusted issuer for this app — and nothing else.
 */
describe("brokered federation", () => {
  const BASE = "http://127.0.0.1:18788";
  const originalIdentityBase = identitySeams.identityBase;
  const originalRestoreSession = identitySeams.restoreSession;

  function stubDiscoveryAt(issuer: string): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          }),
        ),
      ),
    );
  }

  /** jsdom will not navigate, so the authorize URL is captured instead. */
  function captureNavigation() {
    const seen: string[] = [];
    vi.stubGlobal("location", {
      origin: window.location.origin,
      hostname: window.location.hostname,
      href: window.location.href,
      search: window.location.search,
      assign: (url: string) => {
        seen.push(url);
      },
    });
    return {
      assigned: () => (seen[0] ? new URL(seen[0]) : undefined),
    };
  }

  beforeEach(() => {
    identitySeams.identityBase = () => BASE;
  });

  afterEach(() => {
    identitySeams.identityBase = originalIdentityBase;
    identitySeams.restoreSession = originalRestoreSession;
  });

  it("names the provider under both hint parameters the login page reads", async () => {
    stubDiscoveryAt(BASE);
    const nav = captureNavigation();
    await beginSignIn(
      brokeredUpstream({
        id: "google",
        label: "Google",
        kind: "oidc",
        browserCapable: false,
      }),
      { providerHint: "google", returnTo: "/" },
    );
    const url = nav.assigned();
    expect(url?.searchParams.get("kc_idp_hint")).toBe("google");
    expect(url?.searchParams.get("login_hint_provider")).toBe("google");
    // No provider hint means no hint parameters at all.
    expect(url?.searchParams.get("login_hint")).toBeNull();
  });

  it("carries only the work-email domain into home-realm discovery", async () => {
    stubDiscoveryAt(BASE);
    const nav = captureNavigation();
    await beginSignIn(brokeredRealmUpstream(), {
      returnTo: "/",
      loginHint: workEmailDomain("ada.lovelace@acme.example"),
    });
    const url = nav.assigned();
    expect(url?.searchParams.get("login_hint")).toBe("acme.example");
    expect(url?.toString()).not.toContain("ada.lovelace");
  });

  it("admits the configured Identity API as an issuer and adopts its sub", async () => {
    seedPending({
      upstreamId: "broker:google",
      issuer: BASE,
      tokenEndpoint: `${BASE}/token`,
    });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            access_token: "at_brokered",
            id_token: jwt({
              iss: BASE,
              aud: originClientId(),
              exp: 4_000_000_000,
              // The Identity API's origin-profile subject is pairwise already.
              sub: "prn_broker_subject",
            }),
          }),
        ),
      ),
    );
    const result = await completeSignIn();
    expect(result?.identity.pairwiseSub).toBe("prn_broker_subject");
    expect(result?.accessToken).toBe("at_brokered");
    // The brokered identity is a durable Pages session, unlike an org assertion.
    expect(loadSession()?.issuer).toBe(BASE);
  });

  it("still refuses an issuer that is merely close to the Identity API", async () => {
    seedPending({
      issuer: "http://127.0.0.1:18788.evil.example",
      tokenEndpoint: "http://127.0.0.1:18788.evil.example/token",
    });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            access_token: "at_evil",
            id_token: jwt({
              iss: "http://127.0.0.1:18788.evil.example",
              aud: originClientId(),
              exp: 4_000_000_000,
              sub: "whoever",
            }),
          }),
        ),
      ),
    );
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "untrusted_issuer",
    });
  });

  it("refuses a subject-less token from the brokered issuer", async () => {
    seedPending({ issuer: BASE, tokenEndpoint: `${BASE}/token` });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            id_token: jwt({
              iss: BASE,
              aud: originClientId(),
              exp: 4_000_000_000,
            }),
          }),
        ),
      ),
    );
    await expect(completeSignIn()).rejects.toThrowError(/identifies nobody/);
  });

  it("never carries an access token off a direct upstream flow", async () => {
    seedPending();
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            access_token: "at_upstream",
            id_token: jwt({
              iss: "http://127.0.0.1:9090",
              aud: originClientId(),
              exp: 4_000_000_000,
              pairwise_sub: "sub-1",
            }),
          }),
        ),
      ),
    );
    const result = await completeSignIn();
    expect(result?.identity.pairwiseSub).toBe("sub-1");
    expect(result?.accessToken).toBeUndefined();
  });

  it("keeps a stored brokered session only while the Identity API matches", () => {
    saveSession(identity({ issuer: BASE, upstreamId: "broker:google" }));
    expect(loadSession()?.issuer).toBe(BASE);
    // Repointing Settings at another Identity API withdraws that trust.
    identitySeams.identityBase = () => "http://127.0.0.1:28788";
    expect(loadSession()).toBeNull();
  });

  it("never treats an unconfigured Identity API as a trusted issuer", () => {
    identitySeams.identityBase = () => "";
    expect(isBrokeredIssuer("")).toBe(false);
    expect(isBrokeredIssuer(BASE)).toBe(false);
  });

  it("trades the brokered access token for a first-party session", async () => {
    const restored: string[] = [];
    identitySeams.restoreSession = (next) => {
      restored.push(`${next.principalId}:${next.accessToken}`);
    };
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit = {}) => {
        requests.push({ url, body: String(init.body ?? "") });
        return Promise.resolve(
          Response.json({
            principalId: "prn_1",
            accessToken: "pst_first_party",
            expiresAt: "2030-01-01T00:00:00.000Z",
          }),
        );
      }),
    );

    const session = await adoptBrokeredSession("at_brokered");

    expect(session).toMatchObject({
      principalId: "prn_1",
      accessToken: "pst_first_party",
      issuerOrigin: BASE,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(restored).toEqual(["prn_1:pst_first_party"]);
    const sent = requests[0];
    expect(sent?.url).toBe(`${BASE}/v1/principals/federated-session`);
    expect(JSON.parse(sent?.body ?? "null")).toEqual({
      accessToken: "at_brokered",
    });
    // Never the link-identities path: that would bind a pairwise subject to
    // whatever session this tab is holding (T23).
    expect(sent?.url).not.toContain("link-identities");
  });

  it("says the sign-in expired when the Identity API refuses the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_token" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    await expect(adoptBrokeredSession("at_stale")).rejects.toMatchObject({
      code: "session_adoption_failed",
    });
  });

  it("refuses an adoption response that carries no session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ principalId: "prn_1" }))),
    );
    await expect(adoptBrokeredSession("at_odd")).rejects.toThrowError(
      /unusable session/,
    );
  });

  it("cannot adopt anything without an Identity API", async () => {
    identitySeams.identityBase = () => "";
    await expect(adoptBrokeredSession("at_x")).rejects.toMatchObject({
      code: "no_identity_api",
    });
  });
});

describe("an operator's own identity provider", () => {
  /**
   * The road that makes an external IdP the identity service (ADR 0078).
   *
   * Everything here is about one question: does the app run the code flow
   * against the operator's provider with the operator's client, and does
   * naming a provider widen trust by exactly one issuer and no further?
   */
  const OKTA = {
    providerId: "okta",
    issuer: "https://acme.okta.com",
    clientId: "0oa1b2c3d4EXAMPLE",
    label: "Okta",
  };
  const GOOGLE = {
    providerId: "google",
    issuer: "https://accounts.google.com",
    clientId: "google-client.apps",
    label: "Google",
  };

  function withIdps(providers: (typeof OKTA)[]): void {
    const base = originalSettingsSeams.loadSettings();
    settingsSeams.loadSettings = () => ({
      ...base,
      signIn: { builtin: true, providers },
    });
  }

  afterEach(() => {
    settingsSeams.loadSettings = originalSettingsSeams.loadSettings;
  });

  function stubDiscovery() {
    return vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            issuer: OKTA.issuer,
            authorization_endpoint: `${OKTA.issuer}/authorize`,
            token_endpoint: `${OKTA.issuer}/token`,
            jwks_uri: `${OKTA.issuer}/keys`,
          }),
        ),
      ),
    );
  }

  it("is trusted by nobody until an operator names one", () => {
    withIdps([]);
    expect(isOperatorIdpIssuer(OKTA.issuer)).toBe(false);
  });

  it("becomes an upstream carrying the operator's own client id", () => {
    expect(operatorUpstream(OKTA)).toMatchObject({
      issuer: OKTA.issuer,
      clientId: OKTA.clientId,
      accountKind: "Okta",
    });
  });

  it("trusts every issuer the operator listed, and only those", () => {
    withIdps([GOOGLE, OKTA]);
    expect(isOperatorIdpIssuer("https://acme.okta.com/")).toBe(true);
    expect(isOperatorIdpIssuer(GOOGLE.issuer)).toBe(true);
    expect(isOperatorIdpIssuer("https://evil.example")).toBe(false);
  });

  it("presents the operator's client, not this origin's profile", async () => {
    withIdps([OKTA]);
    stubDiscovery();

    await beginSignIn(operatorUpstream(OKTA));

    const pending = storedPending();
    // `origin:<origin>` is a profile only our own brokers mint on sight; a
    // real Okta org would reject it as an unknown client.
    expect(pending.clientId).toBe(OKTA.clientId);
    expect(pending.clientId).not.toBe(originClientId());
    // The app base is the URI the operator registers at their provider.
    expect(pending.redirectUri).toBe(redirectUri());
    // A provider we do not control needs a subject and a name to be worth
    // signing in with; the origin-profile brokers have only ever needed
    // `openid`.
    expect(pending.scope).toBe("openid profile email");
  });

  it("spends the operator's client id at the token endpoint", async () => {
    withIdps([OKTA]);
    seedPending({
      upstreamId: "operator:okta",
      issuer: OKTA.issuer,
      tokenEndpoint: `${OKTA.issuer}/token`,
      jwksUri: `${OKTA.issuer}/keys`,
      redirectUri: redirectUri(),
      clientId: OKTA.clientId,
    });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    // Typed parameters, so the assertion below can read the request body the
    // exchange actually sent rather than an inferred empty tuple.
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          id_token: jwt({
            iss: OKTA.issuer,
            aud: OKTA.clientId,
            sub: "okta-user-1",
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await completeSignIn();
    expect(result?.identity.issuer).toBe(OKTA.issuer);
    // A real provider mints `sub`, not our brokers' `pairwise_sub`.
    expect(result?.identity.pairwiseSub).toBe("okta-user-1");
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain(`client_id=${encodeURIComponent(OKTA.clientId)}`);
    expect(body).not.toContain("origin%3A");
    // Nothing is carried out for adoption: an access token is only ever spent
    // at the Identity API that minted it, and there is none in this road.
    expect(result?.accessToken).toBeUndefined();
  });

  it("refuses a token minted for anyone but the operator's client", async () => {
    withIdps([OKTA]);
    seedPending({
      issuer: OKTA.issuer,
      tokenEndpoint: `${OKTA.issuer}/token`,
      clientId: OKTA.clientId,
    });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            id_token: jwt({
              iss: OKTA.issuer,
              aud: originClientId(),
              sub: "okta-user-1",
              exp: Math.floor(Date.now() / 1000) + 600,
            }),
          }),
        ),
      ),
    );
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "audience_mismatch",
    });
  });

  it("widens trust by exactly the issuers the operator stored", async () => {
    withIdps([OKTA, GOOGLE]);
    seedPending({
      issuer: "https://other.okta.com",
      tokenEndpoint: "https://other.okta.com/token",
      clientId: OKTA.clientId,
    });
    history.replaceState(null, "", "/?code=abc&state=state-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            id_token: jwt({
              iss: "https://other.okta.com",
              aud: OKTA.clientId,
              sub: "someone",
              exp: Math.floor(Date.now() / 1000) + 600,
            }),
          }),
        ),
      ),
    );
    // Naming Okta does not admit every Okta, nor anything else a response
    // happens to claim: the stored issuer, and nothing besides.
    await expect(completeSignIn()).rejects.toMatchObject({
      code: "untrusted_issuer",
    });
  });

  it("drops a stored session once the operator points somewhere else", () => {
    withIdps([OKTA]);
    saveSession(identity({ issuer: OKTA.issuer, upstreamId: "operator:okta" }));
    expect(loadSession()?.issuer).toBe(OKTA.issuer);

    withIdps([{ ...OKTA, issuer: "https://new.okta.com" }]);
    // Trust can be withdrawn between sessions, and an identity from an issuer
    // this app has since been pointed away from must not keep working.
    expect(loadSession()).toBeNull();
  });
});
