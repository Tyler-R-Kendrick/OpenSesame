import { describe, expect, it, vi } from "vitest";
import { loopbackLogin } from "./loopback.js";

const ISSUER = "http://127.0.0.1:8788";

function discovery(overrides: Record<string, unknown> = {}): Response {
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

function idpFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("openid-configuration")) return discovery(overrides);
    if (url.endsWith("/token") && init?.method === "POST") {
      return new Response(
        JSON.stringify({
          access_token: "at",
          token_type: "Bearer",
          expires_in: 60,
        }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
}

describe("loopbackLogin", () => {
  it("completes when the redirect carries the state it minted", async () => {
    let authUrl = "";
    const tokens = await loopbackLogin({
      issuer: ISSUER,
      clientId: "cli",
      fetchImpl: idpFetch(),
      timeoutMs: 5_000,
      openBrowser: async (url) => {
        authUrl = url;
        const parsed = new URL(url);
        const redirectUri = parsed.searchParams.get("redirect_uri");
        const state = parsed.searchParams.get("state");
        if (!redirectUri || !state) throw new Error("missing authorize params");
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", "abc");
        redirect.searchParams.set("state", state);
        await globalThis.fetch(redirect.toString());
      },
    });
    expect(tokens.access_token).toBe("at");
    expect(new URL(authUrl).searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
  });

  it("ignores a callback from something else on the box", async () => {
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
        const redirect = new URL(redirectUri);

        // A stray local process guesses at the port. It must not end the login.
        const stray = new URL(redirect.toString());
        stray.searchParams.set("code", "injected");
        stray.searchParams.set("state", "not-ours");
        const strayRes = await globalThis.fetch(stray.toString());
        expect(strayRes.status).toBe(400);

        redirect.searchParams.set("code", "abc");
        redirect.searchParams.set("state", state);
        await globalThis.fetch(redirect.toString());
      },
    });
    expect(tokens.access_token).toBe("at");
  });

  it("gives up the port when the redirect never arrives", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch(),
        timeoutMs: 40,
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("refuses a discovery document it cannot attribute to the issuer", async () => {
    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch({ issuer: "https://idp.evil" }),
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow(/issuer/i);

    await expect(
      loopbackLogin({
        issuer: ISSUER,
        clientId: "cli",
        fetchImpl: idpFetch({ token_endpoint: "http://idp.evil/token" }),
        openBrowser: () => undefined,
      }),
    ).rejects.toThrow(/token_endpoint/);

    await expect(
      loopbackLogin({ issuer: "http://idp.example", clientId: "cli" }),
    ).rejects.toThrow(/https/i);
  });
});
