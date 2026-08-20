import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenSesame } from "./client.js";
import { BrowserOriginError } from "./origin.js";
import { createPkcePair } from "./pkce.js";
import { createTestSigningKey, mintTestIdToken } from "./test/jwt-fixtures.js";

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
const PAGE = "http://127.0.0.1:5174";
const ORIGIN_CLIENT = `origin:${PAGE}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("zero-config origin mode", () => {
  it("derives origin client id, callback, and openid-only scope", async () => {
    const assigned: string[] = [];
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
        { status: 200 },
      );
    });
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage: new MemStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      windowLocation: {
        href: `${PAGE}/`,
        assign: (u) => {
          assigned.push(u);
        },
        replace: () => undefined,
      },
    });
    await sesame.signIn();
    const url = new URL(assigned[0] as string);
    expect(url.searchParams.get("client_id")).toBe(ORIGIN_CLIENT);
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${PAGE}/opensesame/callback`,
    );
  });

  it("stores a safe returnTo and rejects protocol-relative tricks", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
        }),
        { status: 200 },
      );
    });
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage: new MemStorage(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      windowLocation: {
        href: `${PAGE}/`,
        assign: () => undefined,
        replace: () => undefined,
      },
    });
    await sesame.signIn({ returnTo: "/dashboard" });
    expect(sesame.getReturnTo()).toBe("/dashboard");
    await expect(sesame.signIn({ returnTo: "//evil.com" })).rejects.toThrow(
      BrowserOriginError,
    );
  });

  it("validates the ID token, strips refresh tokens from storage, and scrubs the URL", async () => {
    const keys = await createTestSigningKey();
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
    const idToken = await mintTestIdToken(keys, {
      sub: "pairwise-origin",
      nonce: "nn",
      iss: ISSUER,
      aud: ORIGIN_CLIENT,
    });
    const replaced: string[] = [];
    vi.stubGlobal("history", {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaced.push(url);
      },
    });

    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              issuer: ISSUER,
              authorization_endpoint: `${ISSUER}/auth`,
              token_endpoint: `${ISSUER}/token`,
              jwks_uri: `${ISSUER}/jwks`,
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/jwks")) {
          return new Response(JSON.stringify(keys.jwks), { status: 200 });
        }
        if (url.endsWith("/token") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              access_token: "at",
              refresh_token: "rt-must-not-persist",
              id_token: idToken,
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
      issuer: ISSUER,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      windowLocation: {
        href: `${PAGE}/opensesame/callback?code=abc&state=st`,
        assign: () => undefined,
        replace: () => undefined,
      },
    });
    const session = await sesame.handleRedirectCallback();
    expect(session.sub).toBe("pairwise-origin");
    expect(session.refreshToken).toBe("rt-must-not-persist");
    const stored = JSON.parse(
      storage.getItem("opensesame:session") ?? "{}",
    ) as {
      refreshToken?: string;
      raw?: { refresh_token?: string };
    };
    expect(stored.refreshToken).toBeUndefined();
    expect(stored.raw?.refresh_token).toBeUndefined();
    expect(replaced.some((u) => u.includes("code="))).toBe(false);
    expect(replaced.some((u) => u.includes("/opensesame/callback"))).toBe(true);
  });

  it("refuses an origin-mode token response without an id_token", async () => {
    const storage = new MemStorage();
    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({ state: "st", nonce: "nn", codeVerifier: "cv" }),
    );
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              issuer: ISSUER,
              authorization_endpoint: `${ISSUER}/auth`,
              token_endpoint: `${ISSUER}/token`,
              jwks_uri: `${ISSUER}/jwks`,
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/token") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ access_token: "at", token_type: "Bearer" }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url}`);
      },
    );
    const sesame = createOpenSesame({
      issuer: ISSUER,
      storage,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      windowLocation: {
        href: `${PAGE}/opensesame/callback`,
        assign: () => undefined,
        replace: () => undefined,
      },
    });
    await expect(
      sesame.handleRedirectCallback(
        `${PAGE}/opensesame/callback?code=abc&state=st`,
      ),
    ).rejects.toThrow(/id_token/);
  });
});
