import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createOpenSesame } from "./client.js";
import { createTestSigningKey } from "./test/jwt-fixtures.js";
const signingKeys = createTestSigningKey("ES256");
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

async function idToken(claims: JsonObject): Promise<string> {
  const keys = await signingKeys;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-signing-key" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
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
    storage.setItem(
      "opensesame:pkce",
      JSON.stringify({
        issuer: ISSUER,
        redirectUri: "http://127.0.0.1/callback",
        createdAt: Date.now(),
        ...pkce,
      }),
    );
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/jwks"))
          return new Response(JSON.stringify((await signingKeys).jwks));
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

  it("refuses an undecodable id_token before persisting a session", async () => {
    for (const bad of ["garbage", "a.@@@.b"]) {
      const storage = new MemStorage();
      await expect(
        tokenClient(storage, {
          ...baseTokens,
          id_token: bad,
        }),
      ).rejects.toThrow();
      expect(storage.getItem("opensesame:session")).toBeNull();
    }
  });

  it("refuses an id_token missing mandatory identity claims", async () => {
    await expect(
      tokenClient(new MemStorage(), {
        ...baseTokens,
        id_token: await idToken({ sub: "s1", iss: 42, nonce: "nn" }),
      }),
    ).rejects.toThrow();
  });

  it("accepts an audience list that includes this client", async () => {
    const session = await tokenClient(new MemStorage(), {
      ...baseTokens,
      id_token: await idToken({
        sub: "s1",
        iss: ISSUER,
        aud: ["other", "opensesame-browser"],
        azp: "opensesame-browser",
        nonce: "nn",
      }),
    });
    expect(session.sub).toBe("s1");
  });

  it("rejects an audience list that excludes this client", async () => {
    await expect(
      tokenClient(new MemStorage(), {
        ...baseTokens,
        id_token: await idToken({
          sub: "s1",
          iss: ISSUER,
          aud: ["other"],
          nonce: "nn",
        }),
      }),
    ).rejects.toThrow(/aud/);
  });

  it("refuses a ceremony without its transaction nonce", async () => {
    await expect(
      tokenClient(
        new MemStorage(),
        {
          ...baseTokens,
          id_token: await idToken({
            sub: "s1",
            iss: ISSUER,
            nonce: "anything",
          }),
        },
        { state: "st", codeVerifier: "cv" },
      ),
    ).rejects.toThrow(/nonce/);
  });

  it("refuses a non-string subject", async () => {
    await expect(
      tokenClient(new MemStorage(), {
        ...baseTokens,
        id_token: await idToken({ sub: 42, iss: ISSUER, nonce: "nn" }),
      }),
    ).rejects.toThrow();
  });
});
