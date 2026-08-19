import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Vitest/Vite loads the shipped IIFE as text so we exercise the real file.
import source from "../../public/auth.js?raw";

type OpenSesameApi = {
  authorizeUrl: (options?: {
    brokerBase?: string;
    origin?: string;
    scope?: string;
    state?: string;
  }) => string;
  decodeJwtPayload: (token: string) => Record<string, unknown> | null;
  derivePairwiseSubject: (
    idToken: string,
    rpOrigin?: string,
  ) => Promise<string>;
  acceptSession: (
    session: {
      id_token: string;
      issuer?: string;
      audience?: string;
      jwks_uri: string;
    },
    options?: { audience?: string; issuer?: string; rpOrigin?: string },
  ) => Promise<{ subject: string; claims: Record<string, unknown> }>;
  _getAuthorizeLinkConfig: (anchor: {
    href: string;
  }) => {
    brokerBase: string;
    origin: string;
    scope: string;
    redirectUri?: string;
  } | null;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlJson(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function loadClient(): OpenSesameApi {
  const documentStub = {
    currentScript: {
      src: "https://tyler-r-kendrick.github.io/OpenSesame/auth.js",
      dataset: {},
    },
    addEventListener: vi.fn(),
  };

  const windowStub: Record<string, unknown> = {
    location: {
      origin: "http://localhost:5173",
      href: "http://localhost:5173/",
    },
    OpenSesame: undefined,
    __opensesameAutoBindBootstrapped: undefined,
    __opensesameAuthorizeLinksBootstrapped: undefined,
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    open: vi.fn(),
  };

  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", windowStub);

  runInNewContext(source, {
    CustomEvent,
    TextDecoder,
    TextEncoder,
    URL,
    atob,
    btoa,
    crypto,
    document: documentStub,
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    location: windowStub.location,
    window: windowStub,
  });

  const api = windowStub.OpenSesame as OpenSesameApi | undefined;
  if (!api) throw new Error("OpenSesame API was not installed");
  return api;
}

describe("auth.js client helpers", () => {
  let api: OpenSesameApi;

  beforeEach(() => {
    api = loadClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("builds a broker authorize URL from the script base", () => {
    const url = api.authorizeUrl({
      origin: "http://localhost:5173",
      state: "abcdefghijklmnopqrstuvwx",
      scope: "openid email",
    });
    expect(url).toContain(
      "https://tyler-r-kendrick.github.io/OpenSesame/broker/authorize",
    );
    expect(url).toContain("client_id=origin%3Ahttp%3A%2F%2Flocalhost%3A5173");
    expect(url).toContain("scope=openid+email");
  });

  it("recognizes authorize links without state and ignores prepared ones", () => {
    const plain = api._getAuthorizeLinkConfig({
      href: "https://tyler-r-kendrick.github.io/OpenSesame/broker/authorize?client_id=origin:http://localhost:5173&origin=http://localhost:5173&scope=openid",
    });
    expect(plain).toEqual({
      brokerBase: "https://tyler-r-kendrick.github.io/OpenSesame/",
      origin: "http://localhost:5173",
      scope: "openid",
      redirectUri: undefined,
    });

    const prepared = api._getAuthorizeLinkConfig({
      href: "https://tyler-r-kendrick.github.io/OpenSesame/broker/authorize?client_id=origin:http://localhost:5173&origin=http://localhost:5173&state=already",
    });
    expect(prepared).toBeNull();
  });

  it("decodes JWT payloads and derives a pairwise subject", async () => {
    const payload = b64urlJson({
      pairwise_sub: "pair-abc",
      iss: "https://shoo.dev",
    });
    const token = `${b64urlJson({ alg: "ES256" })}.${payload}.sig`;
    expect(api.decodeJwtPayload(token)?.pairwise_sub).toBe("pair-abc");

    const subject = await api.derivePairwiseSubject(
      token,
      "http://localhost:5173",
    );
    expect(subject).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(subject.length).toBeGreaterThan(20);
  });

  it("acceptSession verifies an ES256 id_token against JWKS", async () => {
    const { subtle } = globalThis.crypto;
    const pair = await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const jwk = (await subtle.exportKey(
      "jwk",
      pair.publicKey,
    )) as JsonWebKey & {
      kid?: string;
      alg?: string;
      use?: string;
    };
    jwk.kid = "test-key";
    jwk.alg = "ES256";
    jwk.use = "sig";

    const header = b64urlJson({ alg: "ES256", kid: "test-key", typ: "JWT" });
    const now = Math.floor(Date.now() / 1000);
    const body = b64urlJson({
      iss: "https://shoo.dev",
      aud: "origin:https://tyler-r-kendrick.github.io",
      exp: now + 3600,
      iat: now,
      pairwise_sub: "pair-1",
    });
    const signingInput = `${header}.${body}`;
    const signature = new Uint8Array(
      await subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(signingInput),
      ),
    );
    const idToken = `${signingInput}.${bytesToBase64Url(signature)}`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ keys: [jwk] }),
      })),
    );

    const accepted = await api.acceptSession(
      {
        id_token: idToken,
        issuer: "https://shoo.dev",
        audience: "origin:https://tyler-r-kendrick.github.io",
        jwks_uri: "https://shoo.dev/.well-known/jwks.json",
      },
      {
        audience: "origin:https://tyler-r-kendrick.github.io",
        issuer: "https://shoo.dev",
        rpOrigin: "http://localhost:5173",
      },
    );

    expect(accepted.claims.pairwise_sub).toBe("pair-1");
    expect(accepted.subject).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
