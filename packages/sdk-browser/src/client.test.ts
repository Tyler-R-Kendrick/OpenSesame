import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenSesame } from "./client.js";
import { createPkcePair, sha256Base64Url } from "./pkce.js";
import { type JsonObject, overlapCast } from "@opensesame/os-domain";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pkce", () => {
  it("produces S256 challenge", async () => {
    const pair = await createPkcePair();
    expect(pair.codeVerifier.length).toBeGreaterThan(20);
    expect(await sha256Base64Url(pair.codeVerifier)).toBe(pair.codeChallenge);
  });
});

describe("createOpenSesame", () => {
  it("signIn redirects with PKCE params", async () => {
    const storage = new MemStorage();
    const assigned: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "http://127.0.0.1:8788",
            authorization_endpoint: "http://127.0.0.1:8788/auth",
            token_endpoint: "http://127.0.0.1:8788/token",
            jwks_uri: "http://127.0.0.1:8788/jwks",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      clientId: "rp-alpha",
      redirectUri: "http://127.0.0.1:5174/callback",
      storage,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: {
        href: "http://127.0.0.1:5174/",
        assign: (u) => {
          assigned.push(u);
        },
        replace: () => undefined,
      },
    });

    await sesame.signIn();
    expect(assigned).toHaveLength(1);
    const authUrl = new URL(overlapCast(assigned[0]));
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("client_id")).toBe("rp-alpha");
    expect(storage.getItem("opensesame:pkce")).toBeTruthy();
  });

  // The control plane mounts /v1/principals/provisional and answers in the
  // product API's camelCase shape (apps/control-plane/src/routes/principals.ts).
  // Pin both here: mocking a path or shape the server does not serve is how the
  // guest button ships broken while CI stays green.
  it("continueAnonymously stores session from control plane", async () => {
    const storage = new MemStorage();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/principals/provisional")) {
        return new Response(
          JSON.stringify({
            principalId: "prn_guest",
            state: "provisional",
            assurance: "provisional",
            sessionId: "ps_1",
            accessToken: "anon-token",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });

    const session = await sesame.continueAnonymously();
    expect(session.anonymous).toBe(true);
    expect(session.accessToken).toBe("anon-token");
    expect(session.sub).toBe("prn_guest");
    expect(session.expiresAt).toBeGreaterThan(Date.now());
    expect((await sesame.getSession())?.accessToken).toBe("anon-token");
  });

  it("continueAnonymously refuses a response without an access token", async () => {
    const storage = new MemStorage();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ principalId: "prn_guest" }), {
          status: 201,
        }),
    );
    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    await expect(sesame.continueAnonymously()).rejects.toThrow(
      /no access token/,
    );
  });

  it("signOut revokes an anonymous session server-side", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "pst_guest",
        anonymous: true,
        raw: { access_token: "pst_guest", token_type: "Bearer" },
      }),
    );
    const seen: Array<{ path: string; auth?: string }> = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const headers = new Headers(init?.headers);
        seen.push({
          path,
          ...(headers.get("authorization")
            ? { auth: overlapCast(headers.get("authorization")) }
            : undefined),
        });
        if (path === "/.well-known/openid-configuration") {
          return new Response(JSON.stringify({}), { status: 404 });
        }
        return new Response(null, { status: 204 });
      },
    );
    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });

    await sesame.signOut();
    expect(await sesame.getSession()).toBeNull();
    expect(seen).toContainEqual({
      path: "/v1/principals/provisional/revoke",
      auth: "Bearer pst_guest",
    });
  });

  // The control plane mounts these under /v1 (apps/control-plane/src/app.ts).
  // Pin the paths here: a prefix that does not exist on the server makes every
  // claim ceremony fail with a 404 that looks like a permissions problem.
  it("calls the control plane paths the server actually mounts", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "at",
        anonymous: false,
        raw: { access_token: "at", token_type: "Bearer" },
      }),
    );
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      seen.push(new URL(String(input)).pathname);
      return new Response(
        JSON.stringify({ id: "clm_1", type: "project", state: "presented" }),
        {
          status: 200,
        },
      );
    });

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });

    await sesame.presentClaim("osc_clm_token");
    await sesame.completeClaim("clm_1", {
      acceptedItemIds: [],
      userCode: "WORD-WORD",
    });

    expect(seen).toEqual(["/v1/claims/present", "/v1/claims/clm_1/complete"]);
  });

  it("handleRedirectCallback exchanges code", async () => {
    const storage = new MemStorage();
    const pkce = await createPkcePair();
    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({
        ...pkce,
        state: "st",
        nonce: "nn",
        codeVerifier: pkce.codeVerifier,
      }),
    );

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              issuer: "http://127.0.0.1:8788",
              authorization_endpoint: "http://127.0.0.1:8788/auth",
              token_endpoint: "http://127.0.0.1:8788/token",
              jwks_uri: "http://127.0.0.1:8788/jwks",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/token") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              access_token: "at",
              id_token: idToken({
                sub: "pairwise-alpha",
                iss: ISSUER,
                aud: "opensesame-browser",
                nonce: "nn",
              }),
              token_type: "Bearer",
              expires_in: 60,
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      },
    );

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      clientId: "opensesame-browser",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });

    const session = await sesame.handleRedirectCallback(
      "http://127.0.0.1:5174/callback?code=abc&state=st",
    );
    expect(session.accessToken).toBe("at");
    expect(session.sub).toBe("pairwise-alpha");
  });

  it("presentClaim, readClaim, and completeClaim hit API", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "at",
        anonymous: false,
        raw: { access_token: "at", token_type: "Bearer" },
      }),
    );
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/claims/present") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "clm_1",
              type: "agent",
              state: "presented",
              targetManifestDigest: "abc",
              expiresAt: new Date().toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/claims/clm_1") && init?.method === undefined) {
          expect(init?.headers).toMatchObject({
            "x-claim-token": "osc_clm_x.secret",
          });
          return new Response(
            JSON.stringify({
              id: "clm_1",
              type: "agent",
              state: "presented",
              targetManifestDigest: "abc",
              expiresAt: new Date().toISOString(),
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/claims/clm_1/complete")) {
          expect(init?.headers).toMatchObject({
            authorization: "Bearer at",
            "x-claim-token": "osc_clm_x.secret",
          });
          expect(JSON.parse(String(init?.body)).claimToken).toBe(
            "osc_clm_x.secret",
          );
          return new Response(
            JSON.stringify({
              id: "clm_1",
              type: "agent",
              state: "completed",
              targetManifestDigest: "abc",
              expiresAt: new Date().toISOString(),
            }),
            { status: 200 },
          );
        }
        throw new Error(url);
      },
    );

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });

    const presented = await sesame.presentClaim("osc_clm_x.secret");
    expect(presented.state).toBe("presented");
    const current = await sesame.readClaim("clm_1", "osc_clm_x.secret");
    expect(current.state).toBe("presented");
    const done = await sesame.completeClaim("clm_1", {
      acceptedItemIds: ["a"],
      userCode: "WORD-WORD",
      claimToken: "osc_clm_x.secret",
    });
    expect(done.state).toBe("completed");
  });

  it("defaults to sessionStorage rather than localStorage", async () => {
    const local = new MemStorage();
    const sessionStore = new MemStorage();
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", sessionStore);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/principals/provisional")) {
        return new Response(
          JSON.stringify({
            principalId: "prn_guest",
            sessionId: "ps_1",
            accessToken: "at",
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      apiBase: "http://127.0.0.1:8788",
      fetchImpl: overlapCast(fetchImpl),
    });
    await sesame.continueAnonymously();
    expect(local.getItem("opensesame:session")).toBeNull();
    const stored = sessionStore.getItem("opensesame:session");
    expect(stored).toBeTruthy();
  });

  it("refuses an id_token that answers a different ceremony", async () => {
    const mint = (claims: JsonObject) =>
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) return discoveryResponse();
        if (url.endsWith("/token") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              access_token: "at",
              token_type: "Bearer",
              expires_in: 60,
              id_token: idToken(claims),
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      });

    const cases: Array<[JsonObject, RegExp]> = [
      [
        {
          sub: "s",
          iss: ISSUER,
          aud: "opensesame-browser",
          nonce: "someone-else",
        },
        /nonce/i,
      ],
      [
        { sub: "s", iss: ISSUER, aud: "another-client", nonce: "nn" },
        /client/i,
      ],
      [
        {
          sub: "s",
          iss: "https://idp.evil",
          aud: "opensesame-browser",
          nonce: "nn",
        },
        /issuer/i,
      ],
    ];
    for (const [claims, message] of cases) {
      const storage = new MemStorage();
      storage.setItem(
        "opensesame:pkce",
        JSON.stringify({ state: "st", nonce: "nn", codeVerifier: "cv" }),
      );
      const sesame = createOpenSesame({
        issuer: ISSUER,
        clientId: "opensesame-browser",
        storage,
        fetchImpl: overlapCast(mint(claims)),
      });
      await expect(
        sesame.handleRedirectCallback(
          "http://127.0.0.1:5174/callback?code=abc&state=st",
        ),
      ).rejects.toThrow(message);
      expect(await sesame.getSession()).toBeNull();
    }
  });

  it("refuses a discovery document that does not name the configured issuer", async () => {
    const storage = new MemStorage();
    const fetchImpl = vi.fn(async () =>
      discoveryResponse({ issuer: "https://idp.evil" }),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: {
        href: "http://127.0.0.1:5174/",
        assign: () => undefined,
        replace: () => undefined,
      },
    });
    await expect(sesame.signIn()).rejects.toThrow(/issuer/i);
  });

  it("refuses endpoints and origins reachable over cleartext", async () => {
    expect(() => createOpenSesame({ issuer: "http://idp.example" })).toThrow(
      /https/i,
    );
    expect(() =>
      createOpenSesame({ issuer: ISSUER, apiBase: "http://api.example" }),
    ).toThrow(/https/i);

    const storage = new MemStorage();
    const fetchImpl = vi.fn(async () =>
      discoveryResponse({ token_endpoint: "http://idp.evil/token" }),
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: overlapCast(fetchImpl),
      windowLocation: {
        href: "http://127.0.0.1:5174/",
        assign: () => undefined,
        replace: () => undefined,
      },
    });
    await expect(sesame.signIn()).rejects.toThrow(/token_endpoint/);
  });

  it("spends the stored verifier once, even when the callback is refused", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({ state: "st", nonce: "nn", codeVerifier: "cv" }),
    );
    const fetchImpl = vi.fn(async () => discoveryResponse());
    const sesame = createOpenSesame({
      issuer: ISSUER,
      clientId: "opensesame-browser",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    await expect(
      sesame.handleRedirectCallback(
        "http://127.0.0.1:5174/callback?code=abc&state=forged",
      ),
    ).rejects.toThrow(/state mismatch/i);
    expect(storage.getItem("opensesame:pkce")).toBeNull();

    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({ state: "st", nonce: "nn", codeVerifier: "cv" }),
    );
    await expect(
      sesame.handleRedirectCallback(
        "http://127.0.0.1:5174/callback?error=access_denied",
      ),
    ).rejects.toThrow(/access_denied/);
    expect(storage.getItem("opensesame:pkce")).toBeNull();
  });

  it("signOut clears session", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:session",
      JSON.stringify({
        accessToken: "at",
        anonymous: false,
        raw: { access_token: "at", token_type: "Bearer" },
      }),
    );
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          issuer: "http://127.0.0.1:8788",
          authorization_endpoint: "http://127.0.0.1:8788/auth",
          token_endpoint: "http://127.0.0.1:8788/token",
          jwks_uri: "http://127.0.0.1:8788/jwks",
        }),
        { status: 200 },
      );
    });
    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: overlapCast(fetchImpl),
    });
    await sesame.signOut();
    expect(await sesame.getSession()).toBeNull();
  });
});
