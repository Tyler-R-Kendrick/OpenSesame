import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import compatibilityHash from "../../public/auth.js.sha384?raw";
import source from "../../public/auth.js?raw";
import previous from "../../public/static-auth/1.0.4/opensesame-auth.min.js?raw";
import immutable from "../../public/static-auth/1.0.5/opensesame-auth.min.js?raw";
import manifest from "../../public/static-auth/manifest.json";

const hosted = {
  profile: "hosted_identity",
  issuer: "https://identity.example",
  clientId: "rp-client",
  redirectUri: "https://rp.example/callback",
  authorizationEndpoint: "https://identity.example/auth",
  tokenEndpoint: "https://identity.example/token",
  jwksUri: "https://identity.example/jwks",
};

async function signedToken(mode: string) {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: mode === "unsigned" ? "none" : "ES256", kid: "key" };
  const claims = {
    iss: hosted.issuer,
    aud: mode === "audience" ? "another-rp" : hosted.clientId,
    sub: "rp-subject",
    nonce: mode === "nonce" ? "another-transaction" : "transaction-nonce",
    iat: now,
    exp: mode === "expired" ? now - 120 : now + 300,
  };
  const input = [header, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      new TextEncoder().encode(input),
    ),
  );
  if (mode === "tampered") signature[0] = (signature[0] ?? 0) ^ 1;
  return {
    token: `${input}.${mode === "unsigned" ? "" : Buffer.from(signature).toString("base64url")}`,
    jwk: {
      ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
      kid: "key",
    },
    expiresAt: claims.exp * 1000,
  };
}

function hostedArtifact(token: string, jwk: JsonWebKey) {
  const events: Event[] = [];
  const key = `opensesame:static-auth:${hosted.clientId}:${hosted.redirectUri}`;
  // A synthetic legacy transaction isolates the emitted verifier. Source
  // tests separately prove that begin() persists only sealed transactions.
  const storage = new Map([
    [
      key,
      JSON.stringify({
        state: "transaction-state",
        nonce: "transaction-nonce",
        codeVerifier: "transaction-verifier",
        createdAt: Date.now(),
        profile: hosted,
      }),
    ],
  ]);
  const browser = {
    OpenSesame: {
      complete: async (
        _profile: typeof hosted,
      ): Promise<{ subject: string; expiresAt: number } | null> => null,
    },
    location: {
      origin: "https://rp.example",
      href: `${hosted.redirectUri}?${new URLSearchParams({ code: "authorization-code", state: "transaction-state", iss: hosted.issuer })}`,
    },
    history: { replaceState: vi.fn() },
    sessionStorage: {
      getItem: (name: string) => storage.get(name) ?? null,
      removeItem: (name: string) => storage.delete(name),
    },
    dispatchEvent: (event: Event) => events.push(event),
  };
  const fetcher = vi.fn(async (url: string) => {
    if (url === hosted.tokenEndpoint) return Response.json({ id_token: token });
    if (url === hosted.jwksUri) return Response.json({ keys: [jwk] });
    throw new Error("unexpected_endpoint");
  });
  runInNewContext(immutable, {
    window: browser,
    CustomEvent,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    Uint8Array,
    crypto,
    CryptoKey,
    atob,
    btoa,
    fetch: fetcher,
    AbortController,
    setTimeout,
    clearTimeout,
    structuredClone,
  });
  return { browser, events, storage, fetcher };
}

describe("shipped authentication SDK", () => {
  it("pins the canonical hosted artifact and frozen loopback compatibility bytes separately", () => {
    expect(compatibilityHash.trim()).toBe(
      "sha384-3ja8qPvrKWHcFXbLAgIeUQVb3yVQO2kDbnomLIY1Jq/GR+Gnmf7WoUcvmFIbM8aq",
    );
    expect(
      `sha384-${createHash("sha384").update(source).digest("base64")}`,
    ).toBe(compatibilityHash.trim());
    expect(
      `sha384-${createHash("sha384").update(immutable).digest("base64")}`,
    ).toBe(manifest.sri);
    expect(manifest.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const previousSri =
      "sha384-YWfxhko3zRIV75/UXieolfporwrMW+sIM2cnTS7NfxzFpq0E3wp+iD+iam8dXrJL";
    expect(
      `sha384-${createHash("sha384").update(previous).digest("base64")}`,
    ).toBe(previousSri);
    expect(manifest.artifacts).toContainEqual({
      path: "apps/pages/public/static-auth/1.0.4/opensesame-auth.min.js",
      sri: previousSri,
    });
  });
  it.each(["valid", "tampered", "unsigned", "nonce", "audience", "expired"])(
    "runs the emitted hosted signature and claim verifier: %s",
    async (mode) => {
      const { token, jwk, expiresAt } = await signedToken(mode);
      const { browser, events, storage, fetcher } = hostedArtifact(token, jwk);
      const complete = browser.OpenSesame.complete(hosted);
      if (mode === "valid") {
        const result = { subject: "rp-subject", expiresAt };
        await expect(complete).resolves.toEqual(result);
        expect(events).toEqual([
          expect.objectContaining({
            type: "opensesame:signed_in",
            detail: result,
          }),
        ]);
      } else {
        await expect(complete).rejects.toThrow("signin_failed");
        expect(events).toEqual([
          expect.objectContaining({
            type: "opensesame:signin_error",
            detail: { code: "signin_failed" },
          }),
        ]);
      }
      expect(storage.size).toBe(0);
      expect(browser.history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        hosted.redirectUri,
      );
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        hosted.tokenEndpoint,
        hosted.jwksUri,
      ]);
      const event = events[0];
      expect(event).toBeInstanceOf(CustomEvent);
      if (event instanceof CustomEvent)
        expect(JSON.stringify(event.detail)).not.toContain(token);
    },
  );
  it("has no default unverified success, session persistence, raw token events, or metadata-based verifier", async () => {
    const browser = {
      OpenSesame: {
        signIn: (_profile?: { profile: string }): Promise<{
          subject?: string;
        }> => Promise.resolve({}),
      },
      dispatchEvent: vi.fn(),
    };
    runInNewContext(source, {
      window: browser,
      CustomEvent,
      TextEncoder,
      TextDecoder,
      URL,
      crypto,
      atob,
      btoa,
    });
    await expect(browser.OpenSesame.signIn()).rejects.toThrow("signin_failed");
    expect(
      browser.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).toEqual(["opensesame:signin_error"]);
    expect(browser.OpenSesame).not.toHaveProperty("acceptSession");
    expect(browser.OpenSesame).not.toHaveProperty("derivePairwiseSubject");
    expect(browser.OpenSesame).not.toHaveProperty("getSession");
  });
});
