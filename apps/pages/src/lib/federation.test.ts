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
  loadSession,
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
      ...overrides,
    }),
  );
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
  history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("trusted upstreams", () => {
  it("picks the local mock IdP on loopback pages", () => {
    expect(location.hostname).toBe("localhost");
    expect(defaultUpstream().id).toBe("mock");
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

    await beginSignIn(upstream, { scope: "openid email", returnTo: "/sites" });

    const pending = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? "null");
    expect(pending).toMatchObject({
      upstreamId: "mock",
      issuer: "http://127.0.0.1:9090",
      scope: "openid email",
      returnTo: "/sites",
      tokenEndpoint: "http://127.0.0.1:9090/token",
      jwksUri: "http://127.0.0.1:9090/jwks",
    });
    expect(pending.verifier).toBeTruthy();
    expect(pending.state).toBeTruthy();
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
    const pending = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? "null");
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

  it("refuses a code when the stored PKCE state is unreadable", async () => {
    sessionStorage.setItem(PKCE_KEY, "{corrupt");
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
    expect(sessionStorage.getItem(PKCE_KEY)).toBeNull();
    // The session survives a same-tab reload until it expires.
    expect(loadSession()?.pairwiseSub).toBe("sub-1");
    // The address bar no longer carries a replayable code.
    expect(location.search).toBe("");
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
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("drops a session whose issuer is no longer trusted", () => {
    saveSession(identity({ issuer: "https://evil.example" }));
    expect(loadSession()).toBeNull();
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it("ignores a corrupt session payload", () => {
    sessionStorage.setItem(SESSION_KEY, "{not json");
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
