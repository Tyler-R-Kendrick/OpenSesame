import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenSesame } from "./client.js";
import { createPkcePair, sha256Base64Url } from "./pkce.js";

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
      fetchImpl: fetchImpl as unknown as typeof fetch,
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
    const authUrl = new URL(assigned[0] as string);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("client_id")).toBe("rp-alpha");
    expect(storage.getItem("opensesame:pkce")).toBeTruthy();
  });

  it("continueAnonymously stores session from control plane", async () => {
    const storage = new MemStorage();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/principals/anonymous")) {
        return new Response(
          JSON.stringify({
            access_token: "anon-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await sesame.continueAnonymously();
    expect(session.anonymous).toBe(true);
    expect(session.accessToken).toBe("anon-token");
    expect((await sesame.getSession())?.accessToken).toBe("anon-token");
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await sesame.presentClaim("osc_clm_token");
    await sesame.completeClaim("clm_1", { acceptedItemIds: [] });

    expect(seen).toEqual(["/v1/claims/present", "/v1/claims/clm_1/complete"]);
  });

  it("handleRedirectCallback exchanges code", async () => {
    const storage = new MemStorage();
    const pkce = await createPkcePair();
    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({ ...pkce, state: "st", codeVerifier: pkce.codeVerifier }),
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
              id_token: `eyJhbGciOiJub25lIn0.${btoa(
                JSON.stringify({ sub: "pairwise-alpha" }),
              )
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/u, "")}.`,
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
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await sesame.handleRedirectCallback(
      "http://127.0.0.1:5174/callback?code=abc&state=st",
    );
    expect(session.accessToken).toBe("at");
    expect(session.sub).toBe("pairwise-alpha");
  });

  it("presentClaim and completeClaim hit API", async () => {
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
        if (url.endsWith("/claims/clm_1/complete")) {
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const presented = await sesame.presentClaim("osc_clm_x.secret");
    expect(presented.state).toBe("presented");
    const done = await sesame.completeClaim("clm_1", {
      acceptedItemIds: ["a"],
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
      if (url.endsWith("/v1/principals/anonymous")) {
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
      throw new Error(`unexpected fetch ${url}`);
    });

    const sesame = createOpenSesame({
      issuer: "http://127.0.0.1:8788",
      apiBase: "http://127.0.0.1:8788",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sesame.continueAnonymously();
    expect(local.getItem("opensesame:session")).toBeNull();
    const stored = sessionStore.getItem("opensesame:session");
    expect(stored).toBeTruthy();
    expect(stored).not.toContain("rt-secret");
    expect(stored).not.toContain("refresh_token");
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
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sesame.signOut();
    expect(await sesame.getSession()).toBeNull();
  });
});
