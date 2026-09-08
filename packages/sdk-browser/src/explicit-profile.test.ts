import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import { SignJWT } from "jose";
import { expect, it, vi } from "vitest";
import { createOpenSesame } from "./client.js";
import { createPkcePair } from "./pkce.js";
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

it("handleRedirectCallback exchanges code", async () => {
  const storage = new MemStorage();
  const pkce = await createPkcePair();
  storage.setItem(
    "opensesame:pkce",
    JSON.stringify({
      issuer: ISSUER,
      redirectUri: "http://127.0.0.1:5174/callback",
      createdAt: Date.now(),
      ...pkce,
      state: "st",
      nonce: "nn",
      codeVerifier: pkce.codeVerifier,
    }),
  );

  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/jwks"))
        return new Response(JSON.stringify((await signingKeys).jwks));
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
            id_token: await idToken({
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
    redirectUri: "http://127.0.0.1:5174/callback",
    storage,
    fetchImpl: overlapCast(fetchImpl),
  });

  const session = await sesame.handleRedirectCallback(
    "http://127.0.0.1:5174/callback?code=abc&state=st",
  );
  expect(session.accessToken).toBe("at");
  expect(session.sub).toBe("pairwise-alpha");
});
