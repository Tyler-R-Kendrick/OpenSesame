import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertDiscoveredUrl,
  assertSecureUrl,
  createOpenSesame,
} from "./client.js";
import { ClaimRequestError } from "./errors.js";
import * as sdk from "./index.js";
import { type JsonObject, overlapCast, type BoundaryValue, isFunction } from "@opensesame/os-domain";
import type { Session } from "./types.js";

class MemStorage {
  readonly #m = new Map<string, string>();
  getItem(k: string) {
    return this.#m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.#m.set(k, v);
  }
  removeItem(k: string) {
    this.#m.delete(k);
  }
}

const ISSUER = "http://127.0.0.1:8788";

function b64url(value: string): string {
  return btoa(value)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function idToken(claims: JsonObject): string {
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(claims))}.`;
}

function discoveryResponse(overrides: JsonObject = {}): Response {
  return new Response(
    JSON.stringify({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      ...overrides,
    }),
    { status: 200 },
  );
}

function windowLocation(href = "http://127.0.0.1:5174/") {
  const assigned: string[] = [];
  return {
    assigned,
    loc: {
      href,
      assign: (u: string) => {
        assigned.push(u);
      },
      replace: () => undefined,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("package exports", () => {
  it("exposes the public surface from index", () => {
    expect(isFunction(sdk.createOpenSesame)).toBe(true);
    expect(isFunction(sdk.createPkcePair)).toBe(true);
    expect(isFunction(sdk.randomString)).toBe(true);
    expect(isFunction(sdk.sha256Base64Url)).toBe(true);
    expect(isFunction(sdk.base64UrlEncode)).toBe(true);
    expect(isFunction(sdk.ClaimRequestError)).toBe(true);
    expect(isFunction(sdk.canonicalizeBrowserOrigin)).toBe(true);
    expect(isFunction(sdk.originProfileClientId)).toBe(true);
    expect(isFunction(sdk.assertSafeReturnTo)).toBe(true);
  });
});

describe("ClaimRequestError", () => {
  it("carries status and a stable name", () => {
    const err = new ClaimRequestError("gone", 410);
    expect(err.name).toBe("ClaimRequestError");
    expect(err.status).toBe(410);
    expect(err.message).toBe("gone");
    expect(err).toBeInstanceOf(Error);
  });

  it("marks final statuses as spent and throttles/server errors as retryable", () => {
    for (const status of [400, 401, 404, 409, 410, 422]) {
      expect(new ClaimRequestError("x", status).spent).toBe(true);
    }
    for (const status of [429, 500, 503]) {
      expect(new ClaimRequestError("x", status).spent).toBe(false);
    }
  });
});

describe("assertSecureUrl", () => {
  it("accepts https anywhere", () => {
    expect(assertSecureUrl("https://idp.example", "issuer")).toBe(
      "https://idp.example",
    );
  });

  it("accepts http only on loopback hosts", () => {
    for (const url of [
      "http://localhost:8788",
      "http://foo.localhost:8788",
      "http://127.0.0.2:8788",
      "http://[::1]:8788",
    ]) {
      expect(assertSecureUrl(url, "issuer")).toBe(url);
    }
  });

  it("refuses cleartext off loopback and non-http schemes", () => {
    expect(() => assertSecureUrl("http://example.com", "issuer")).toThrow(
      /https/,
    );
    expect(() => assertSecureUrl("ftp://example.com", "issuer")).toThrow(
      /https/,
    );
  });

  it("refuses relative URLs", () => {
    expect(() => assertSecureUrl("/callback", "issuer")).toThrow(
      /absolute URL/,
    );
  });
});

describe("assertDiscoveredUrl", () => {
  const WHAT = "token_endpoint";

  it("refuses an issuer that is not an absolute URL", () => {
    expect(() =>
      assertDiscoveredUrl("https://a.example", WHAT, "nope"),
    ).toThrow(/issuer must be an absolute URL/);
  });

  it("lets a private issuer name private endpoints", () => {
    expect(assertDiscoveredUrl("https://192.168.1.1/token", WHAT, ISSUER)).toBe(
      "https://192.168.1.1/token",
    );
  });

  it("refuses private or loopback endpoints from a remote issuer", () => {
    for (const url of [
      "https://127.0.0.1/token",
      "https://[::1]/token",
      "https://localhost/token",
      "https://0.0.0.0/token",
      "https://[::]/token",
      "https://10.1.2.3/token",
      "https://0.1.2.3/token",
      "https://169.254.0.1/token",
      "https://172.16.0.1/token",
      "https://172.31.255.255/token",
      "https://192.168.0.1/token",
      "https://[fd00::1]/token",
      "https://[fe80::1]/token",
      "https://[fe90::1]/token",
      "https://printer.internal/token",
      "https://nas.local/token",
    ]) {
      expect(() =>
        assertDiscoveredUrl(url, WHAT, "https://idp.example"),
      ).toThrow(/private or loopback/);
    }
  });

  it("accepts public endpoints from a remote issuer", () => {
    for (const url of [
      "https://172.15.0.1/token",
      "https://172.32.0.1/token",
      "https://192.167.0.1/token",
      "https://8.8.8.8/token",
      "https://idp.example/token",
    ]) {
      expect(assertDiscoveredUrl(url, WHAT, "https://idp.example")).toBe(url);
    }
  });
});

describe("storage resolution", () => {
  it("falls back to in-memory storage when no Web Storage exists", async () => {
    vi.stubGlobal("sessionStorage", undefined);
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ principalId: "prn_1", accessToken: "at" }),
          { status: 201 },
        ),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      fetchImpl: overlapCast(fetchImpl),
    });
    await sesame.continueAnonymously();
    // Memory storage is per-client: the session is readable on this instance.
    expect((await sesame.getSession())?.accessToken).toBe("at");
    const other = createOpenSesame({
      issuer: ISSUER,
      fetchImpl: overlapCast(fetchImpl),
    });
    expect(await other.getSession()).toBeNull();
  });

  it("falls back to memory when sessionStorage itself throws", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ principalId: "prn_1", accessToken: "at" }),
          { status: 201 },
        ),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      fetchImpl: overlapCast(fetchImpl),
    });
    await sesame.continueAnonymously();
    expect((await sesame.getSession())?.accessToken).toBe("at");
  });
});

describe("discovery", () => {
  function client(fetchImpl: BoundaryValue, storage = new MemStorage()) {
    return createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: windowLocation().loc,
    });
  }

  it("caches the discovery document across calls", async () => {
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = client(fetchImpl);
    await sesame.signIn();
    await sesame.signIn();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails when the discovery endpoint is unreachable", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 500 }));
    await expect(client(fetchImpl).signIn()).rejects.toThrow(
      /OIDC discovery failed: 500/,
    );
  });

  it("refuses a document that omits the issuer", async () => {
    const fetchImpl = vi.fn(async () =>
      discoveryResponse({ issuer: undefined }),
    );
    await expect(client(fetchImpl).signIn()).rejects.toThrow(
      /issuer does not match/,
    );
  });

  it("refuses a private authorization endpoint from a remote issuer", async () => {
    const remote = "https://idp.example";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: remote,
            authorization_endpoint: "http://127.0.0.1/auth",
            token_endpoint: `${remote}/token`,
          }),
          { status: 200 },
        ),
    );
    const sesame = createOpenSesame({
      issuer: remote,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: windowLocation().loc,
    });
    await expect(sesame.signIn()).rejects.toThrow(
      /authorization_endpoint names a private or loopback host/,
    );
  });

  it("validates end_session_endpoint when the document names one", async () => {
    const fetchImpl = vi.fn(async () =>
      discoveryResponse({ end_session_endpoint: "http://idp.evil/logout" }),
    );
    await expect(client(fetchImpl).signIn()).rejects.toThrow(
      /end_session_endpoint/,
    );
  });

  it("accepts an end_session_endpoint the private issuer may name", async () => {
    const fetchImpl = vi.fn(async () =>
      discoveryResponse({ end_session_endpoint: "https://10.0.0.5/logout" }),
    );
    await expect(client(fetchImpl).signIn()).resolves.toBeUndefined();
  });
});

describe("signIn", () => {
  it("adds IdP hints when a provider is requested", async () => {
    const { loc, assigned } = windowLocation();
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage: new MemStorage(),
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: loc,
    });
    await sesame.signIn({ provider: "keycloak" });
    const url = new URL(overlapCast(assigned[0]));
    expect(url.searchParams.get("kc_idp_hint")).toBe("keycloak");
    expect(url.searchParams.get("login_hint_provider")).toBe("keycloak");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("defaults client id, scopes, and loopback redirect", async () => {
    const { loc, assigned } = windowLocation();
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage: new MemStorage(),
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: loc,
    });
    await sesame.signIn();
    const url = new URL(overlapCast(assigned[0]));
    expect(url.searchParams.get("client_id")).toBe(
      "origin:http://127.0.0.1:5174",
    );
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:5174/opensesame/callback",
    );
    expect(url.searchParams.has("kc_idp_hint")).toBe(false);
  });

  it("honours custom scopes", async () => {
    const { loc, assigned } = windowLocation();
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      scopes: ["openid", "email"],
      storage: new MemStorage(),
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: loc,
    });
    await sesame.signIn();
    expect(new URL(overlapCast(assigned[0])).searchParams.get("scope")).toBe(
      "openid email",
    );
  });

  it("fails closed when there is nowhere to redirect", async () => {
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage: new MemStorage(),
      fetchImpl: overlapCast(fetchImpl),
    });
    await expect(sesame.signIn()).rejects.toThrow(/No window.location/);
  });
});

describe("handleRedirectCallback", () => {
  function pkceStorage(storage: MemStorage, pkce: string | null) {
    if (pkce !== null) storage.setItem("opensesame:pkce", pkce);
  }

  it("reads the callback URL from window.location when none is passed", async () => {
    const storage = new MemStorage();
    pkceStorage(
      storage,
      JSON.stringify({ state: "st", nonce: "nn", codeVerifier: "cv" }),
    );
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) return discoveryResponse();
        if (url.endsWith("/token") && init?.method === "POST") {
          expect(String(init.body)).toContain("code_verifier=cv");
          return new Response(
            JSON.stringify({ access_token: "at", token_type: "Bearer" }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    const { loc } = windowLocation(
      "http://127.0.0.1:5174/callback?code=abc&state=st",
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      clientId: "opensesame-browser",
      storage,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: loc,
    });
    const session = await sesame.handleRedirectCallback();
    expect(session.accessToken).toBe("at");
    expect(session.idToken).toBeUndefined();
    expect(session.sub).toBeUndefined();
    expect(session.expiresAt).toBeUndefined();
  });

  it("rejects callbacks missing code, state, or stored PKCE", async () => {
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = (storage: MemStorage) =>
      createOpenSesame({
        issuer: ISSUER,
        storage,
        fetchImpl: overlapCast(fetchImpl),
      });

    const noCode = new MemStorage();
    pkceStorage(noCode, JSON.stringify({ state: "st", codeVerifier: "cv" }));
    await expect(
      sesame(noCode).handleRedirectCallback(
        "http://127.0.0.1/callback?state=st",
      ),
    ).rejects.toThrow(/Missing authorization code or PKCE state/);

    const noState = new MemStorage();
    pkceStorage(noState, JSON.stringify({ state: "st", codeVerifier: "cv" }));
    await expect(
      sesame(noState).handleRedirectCallback(
        "http://127.0.0.1/callback?code=abc",
      ),
    ).rejects.toThrow(/Missing authorization code or PKCE state/);

    const noPkce = new MemStorage();
    await expect(
      sesame(noPkce).handleRedirectCallback(
        "http://127.0.0.1/callback?code=abc&state=st",
      ),
    ).rejects.toThrow(/Missing authorization code or PKCE state/);
  });

  it("refuses an unreadable stored PKCE value and clears it", async () => {
    const storage = new MemStorage();
    storage.setItem("opensesame:pkce", "{not json");
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    await expect(
      sesame.handleRedirectCallback(
        "http://127.0.0.1/callback?code=abc&state=st",
      ),
    ).rejects.toThrow(/unreadable/);
    expect(storage.getItem("opensesame:pkce")).toBeNull();
  });

  it("surfaces token endpoint failures", async () => {
    const storage = new MemStorage();
    pkceStorage(storage, JSON.stringify({ state: "st", codeVerifier: "cv" }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openid-configuration")) return discoveryResponse();
      return new Response("nope", { status: 400 });
    });
    const sesame = createOpenSesame({
      issuer: ISSUER,
      clientId: "opensesame-browser",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    await expect(
      sesame.handleRedirectCallback(
        "http://127.0.0.1/callback?code=abc&state=st",
      ),
    ).rejects.toThrow(/Token exchange failed: 400/);
  });
});

describe("id_token handling", () => {
  function tokenClient(
    storage: MemStorage,
    tokens: JsonObject,
    pkce: JsonObject = {
      state: "st",
      nonce: "nn",
      codeVerifier: "cv",
    },
  ) {
    storage.setItem("opensesame:pkce", JSON.stringify(pkce));
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) return discoveryResponse();
        if (url.endsWith("/token") && init?.method === "POST") {
          return new Response(JSON.stringify(tokens), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      clientId: "opensesame-browser",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    return sesame.handleRedirectCallback(
      "http://127.0.0.1/callback?code=abc&state=st",
    );
  }

  const baseTokens = { access_token: "at", token_type: "Bearer" };

  it("tolerates an undecodable id_token and derives no sub", async () => {
    for (const bad of ["garbage", "a.@@@.b"]) {
      const session = await tokenClient(new MemStorage(), {
        ...baseTokens,
        id_token: bad,
      });
      expect(session.sub).toBeUndefined();
      expect(session.idToken).toBe(bad);
    }
  });

  it("accepts an id_token with no issuer, audience, or nonce claims", async () => {
    const session = await tokenClient(new MemStorage(), {
      ...baseTokens,
      id_token: idToken({ sub: "s1", iss: 42, nonce: "nn" }),
    });
    expect(session.sub).toBe("s1");
  });

  it("accepts an audience list that includes this client", async () => {
    const session = await tokenClient(new MemStorage(), {
      ...baseTokens,
      id_token: idToken({
        sub: "s1",
        iss: ISSUER,
        aud: ["other", "opensesame-browser"],
        nonce: "nn",
      }),
    });
    expect(session.sub).toBe("s1");
  });

  it("rejects an audience list that excludes this client", async () => {
    await expect(
      tokenClient(new MemStorage(), {
        ...baseTokens,
        id_token: idToken({
          sub: "s1",
          iss: ISSUER,
          aud: ["other"],
          nonce: "nn",
        }),
      }),
    ).rejects.toThrow(/different client/);
  });

  it("skips the nonce check when the ceremony stored none", async () => {
    const session = await tokenClient(
      new MemStorage(),
      {
        ...baseTokens,
        id_token: idToken({ sub: "s1", iss: ISSUER, nonce: "anything" }),
      },
      { state: "st", codeVerifier: "cv" },
    );
    expect(session.sub).toBe("s1");
  });

  it("ignores a non-string sub", async () => {
    const session = await tokenClient(new MemStorage(), {
      ...baseTokens,
      id_token: idToken({ sub: 42, iss: ISSUER, nonce: "nn" }),
    });
    expect(session.sub).toBeUndefined();
  });
});

describe("session persistence", () => {
  it("keeps refresh tokens out of storage and reattaches them in-process", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({ state: "st", codeVerifier: "cv" }),
    );
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) return discoveryResponse();
        if (url.endsWith("/token") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              access_token: "at",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "rt-secret",
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      clientId: "opensesame-browser",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    const session = await sesame.handleRedirectCallback(
      "http://127.0.0.1/callback?code=abc&state=st",
    );
    expect(session.refreshToken).toBe("rt-secret");

    const stored: Session = overlapCast(
      JSON.parse(overlapCast(storage.getItem("opensesame:session"))),
    );
    expect(stored.refreshToken).toBeUndefined();
    expect(stored.raw.refresh_token).toBeUndefined();

    // Same client instance: refresh token survives via memory.
    expect((await sesame.getSession())?.refreshToken).toBe("rt-secret");

    // New client instance over the same storage: refresh token is gone.
    const fresh = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    const restored = await fresh.getSession();
    expect(restored?.accessToken).toBe("at");
    expect(restored?.refreshToken).toBeUndefined();
  });

  it("drops a corrupted stored session", async () => {
    const storage = new MemStorage();
    storage.setItem("opensesame:session", "{corrupt");
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(async () => {
        throw new Error("no network");
      }),
    });
    expect(await sesame.getSession()).toBeNull();
    expect(storage.getItem("opensesame:session")).toBeNull();
  });

  it("evicts an expired session", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "at",
        anonymous: false,
        expiresAt: Date.now() - 1000,
        raw: { access_token: "at", token_type: "Bearer" },
      }),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(async () => {
        throw new Error("no network");
      }),
    });
    expect(await sesame.getSession()).toBeNull();
    expect(storage.getItem("opensesame:session")).toBeNull();
  });
});

describe("continueAnonymously", () => {
  function anonClient(body: JsonObject, status = 201) {
    const storage = new MemStorage();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(body), { status }),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    return { sesame, storage };
  }

  it("surfaces control-plane failures", async () => {
    const { sesame } = anonClient({}, 503);
    await expect(sesame.continueAnonymously()).rejects.toThrow(
      /Anonymous session failed: 503/,
    );
  });

  it("refuses an empty access token", async () => {
    const { sesame } = anonClient({ accessToken: "" });
    await expect(sesame.continueAnonymously()).rejects.toThrow(
      /no access token/,
    );
  });

  it("tolerates missing expiry, principal, and token type", async () => {
    const { sesame } = anonClient({ accessToken: "at" });
    const session = await sesame.continueAnonymously();
    expect(session.expiresAt).toBeUndefined();
    expect(session.sub).toBeUndefined();
    expect(session.raw.token_type).toBe("Bearer");
    expect(session.raw.expires_in).toBeUndefined();
  });

  it("ignores an unparseable expiresAt", async () => {
    const { sesame } = anonClient({
      accessToken: "at",
      expiresAt: "not-a-date",
    });
    const session = await sesame.continueAnonymously();
    expect(session.expiresAt).toBeUndefined();
    expect(session.raw.expires_in).toBeUndefined();
  });
});

describe("claim endpoints", () => {
  function claimClient(session: boolean) {
    const storage = new MemStorage();
    if (session) {
      storage.setItem(
        "opensesame:session",
        JSON.stringify({
          accessToken: "at",
          anonymous: false,
          raw: { access_token: "at", token_type: "Bearer" },
        }),
      );
    }
    const seen: Array<{ path: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        seen.push({ path: url.pathname, ...(init ? { init } : undefined) });
        if (
          url.pathname.includes("missing") ||
          String(init?.body ?? "").includes("missing")
        ) {
          return new Response("no", { status: 404 });
        }
        if (url.pathname.includes("conflict")) {
          return new Response("no", { status: 409 });
        }
        return new Response(
          JSON.stringify({ id: "clm_1", type: "agent", state: "presented" }),
          { status: 200 },
        );
      },
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    return { sesame, seen };
  }

  it("presents a claim without a session, sending no bearer", async () => {
    const { sesame, seen } = claimClient(false);
    await sesame.presentClaim("osc_clm_token");
    const headers = new Headers(seen[0]?.init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(JSON.parse(String(seen[0]?.init?.body)).token).toBe("osc_clm_token");
  });

  it("surfaces presentClaim failures", async () => {
    const { sesame } = claimClient(false);
    await expect(sesame.presentClaim("missing")).rejects.toThrow(
      /presentClaim failed: 404/,
    );
  });

  it("encodes the claim id in readClaim and surfaces failures", async () => {
    const { sesame, seen } = claimClient(false);
    await sesame.readClaim("clm/1", "tok");
    expect(seen[0]?.path).toBe("/v1/claims/clm%2F1");
    await expect(sesame.readClaim("missing", "tok")).rejects.toThrow(
      /readClaim failed: 404/,
    );
  });

  it("sends destination and idempotency key, omitting claim token headers", async () => {
    const { sesame, seen } = claimClient(true);
    await sesame.completeClaim("clm_1", {
      acceptedItemIds: ["a"],
      userCode: "WORD-WORD",
      destination: { kind: "wallet" },
      idempotencyKey: "idem-1",
    });
    const call = seen[0];
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("x-claim-token")).toBeNull();
    const body = overlapCast(JSON.parse(String(call?.init?.body)));
    expect(body.destination).toEqual({ kind: "wallet" });
    expect(body.idempotencyKey).toBe("idem-1");
    expect(body.claimToken).toBeUndefined();
  });

  it("surfaces completeClaim failures", async () => {
    const { sesame } = claimClient(true);
    await expect(
      sesame.completeClaim("conflict", {
        acceptedItemIds: [],
        userCode: "WORD-WORD",
      }),
    ).rejects.toThrow(/completeClaim failed: 409/);
  });
});

describe("linkIdentity", () => {
  it("delegates to signIn with the provider hint", async () => {
    const { loc, assigned } = windowLocation();
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage: new MemStorage(),
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: loc,
    });
    await sesame.linkIdentity({ provider: "github" });
    expect(assigned).toHaveLength(1);
    const url = new URL(overlapCast(assigned[0]));
    expect(url.searchParams.get("kc_idp_hint")).toBe("github");
  });
});

describe("signOut", () => {
  it("redirects to the discovered end_session_endpoint", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "at",
        anonymous: false,
        raw: { access_token: "at", token_type: "Bearer" },
      }),
    );
    const { loc, assigned } = windowLocation();
    const fetchImpl = vi.fn(async () =>
      discoveryResponse({ end_session_endpoint: `${ISSUER}/logout` }),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: loc,
    });
    await sesame.signOut();
    expect(assigned).toEqual([`${ISSUER}/logout`]);
    expect(await sesame.getSession()).toBeNull();
  });

  it("succeeds even when the provisional revoke call throws", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "pst",
        anonymous: true,
        raw: { access_token: "pst", token_type: "Bearer" },
      }),
    );
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    await expect(sesame.signOut()).resolves.toBeUndefined();
    expect(await sesame.getSession()).toBeNull();
    expect(storage.getItem("opensesame:pkce")).toBeNull();
  });
});
