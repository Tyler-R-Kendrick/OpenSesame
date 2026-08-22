import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import { loopbackLogin } from "./loopback.js";

const ISSUER = "http://127.0.0.1:8788";

function discovery(overrides: JsonObject = {}): Response {
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

function idpFetch(
  tokenResponder: () => Promise<Response> = async () =>
    new Response(JSON.stringify({ access_token: "at", token_type: "Bearer" }), {
      status: 200,
    }),
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openid-configuration")) return discovery();
    if (url.endsWith("/token") && init?.method === "POST") {
      return tokenResponder();
    }
    throw new Error(`unexpected ${url}`);
  });
}

type OpenBrowser = (url: string) => Promise<void> | void;

/** Drives the loopback callback as the browser would. */
function browserRedirect(
  mutate: (redirect: URL, state: string) => void,
): OpenBrowser {
  return async (url) => {
    const parsed = new URL(url);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    const state = parsed.searchParams.get("state");
    if (!redirectUri || !state) throw new Error("missing authorize params");
    const redirect = new URL(redirectUri);
    mutate(redirect, state);
    await globalThis.fetch(redirect.toString());
  };
}

describe("loopbackLogin callback handling", () => {
  it("answers 404 to anything that is not the callback path", async () => {
    const tokens = await loopbackLogin({
      issuer: ISSUER,
      clientId: "cli",
      fetchImpl: idpFetch(),
      timeoutMs: 5_000,
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        if (!redirectUri || !state) throw new Error("missing authorize params");
        const base = new URL(redirectUri);

        const stray = await globalThis.fetch(`${base.origin}/favicon.ico`);
        expect(stray.status).toBe(404);

        base.searchParams.set("code", "abc");
        base.searchParams.set("state", state);
        await globalThis.fetch(base.toString());
      },
    });
    expect(tokens.access_token).toBe("at");
  });

  it("rejects with the provider's error when the user refuses", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch(),
        timeoutMs: 5_000,
        openBrowser: browserRedirect((redirect, state) => {
          redirect.searchParams.set("error", "access_denied");
          redirect.searchParams.set("state", state);
        }),
      }),
    ).rejects.toThrow(/access_denied/u);
  });

  it("rejects a callback that carries neither code nor error", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch(),
        timeoutMs: 5_000,
        openBrowser: browserRedirect((redirect, state) => {
          redirect.searchParams.set("state", state);
        }),
      }),
    ).rejects.toThrow(/invalid callback/u);
  });

  it("rejects when the token exchange is refused", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch(
          async () => new Response(JSON.stringify({}), { status: 500 }),
        ),
        timeoutMs: 5_000,
        openBrowser: browserRedirect((redirect, state) => {
          redirect.searchParams.set("code", "abc");
          redirect.searchParams.set("state", state);
        }),
      }),
    ).rejects.toThrow(/token exchange failed: 500/u);
  });

  it("refuses a malformed token response", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch(
          async () => new Response(JSON.stringify({ access_token: "at" })),
        ),
        timeoutMs: 5_000,
        openBrowser: browserRedirect((redirect, state) => {
          redirect.searchParams.set("code", "abc");
          redirect.searchParams.set("state", state);
        }),
      }),
    ).rejects.toThrow(/response was invalid/u);
  });

  it("rejects when the token endpoint cannot be reached", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch(async () => {
          throw new Error("connection reset");
        }),
        timeoutMs: 5_000,
        openBrowser: browserRedirect((redirect, state) => {
          redirect.searchParams.set("code", "abc");
          redirect.searchParams.set("state", state);
        }),
      }),
    ).rejects.toThrow(/connection reset/u);
  });

  it("completes even when opening the browser fails", async () => {
    // The CLI cannot force a browser open; a failure there must not cancel a
    // login the user can still finish from a printed URL.
    let authUrl = "";
    const promise = loopbackLogin({
      issuer: ISSUER,
      clientId: "cli",
      fetchImpl: idpFetch(),
      timeoutMs: 5_000,
      openBrowser: async (url) => {
        authUrl = url;
        throw new Error("no browser on this box");
      },
    });
    // Drive the redirect directly once the server is up, as if the user had
    // opened the URL by hand.
    for (let i = 0; i < 50 && !authUrl; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const parsed = new URL(authUrl);
    const redirectUri = parsed.searchParams.get("redirect_uri");
    const state = parsed.searchParams.get("state");
    if (!redirectUri || !state) throw new Error("missing authorize params");
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", "abc");
    redirect.searchParams.set("state", state);
    await globalThis.fetch(redirect.toString());
    await expect(promise).resolves.toMatchObject({ access_token: "at" });
  });

  it("rejects when the caller aborts", async () => {
    const controller = new AbortController();
    const promise = loopbackLogin({
      issuer: ISSUER,
      clientId: "cli",
      fetchImpl: idpFetch(),
      timeoutMs: 5_000,
      signal: controller.signal,
      openBrowser: () => {
        controller.abort();
      },
    });
    await expect(promise).rejects.toThrow(/aborted/u);
  });

  it("surfaces a discovery failure with the status", async () => {
    const fetchImpl: typeof fetch = vi.fn(
      async () => new Response(JSON.stringify({}), { status: 503 }),
    );
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl,
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow(/discovery failed: 503/u);
  });
});
