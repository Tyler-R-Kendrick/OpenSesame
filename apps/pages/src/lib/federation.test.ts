import { type JsonObject, type BoundaryValue } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FederationError,
  TRUSTED_UPSTREAMS,
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
  loadSession,
  originClientId,
  redirectUri,
  saveSession,
  upstreamByIssuer,
} from "./federation.js";
import type { UpstreamIdentity } from "./federation.js";

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
