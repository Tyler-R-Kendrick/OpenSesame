import type { JsonObject } from "@opensesame/os-domain";
import { SignJWT } from "jose";
import { afterEach, expect, it, vi } from "vitest";
import { assertCallbackTransaction } from "./callback-transaction.js";
import { fetchOidcJson, verifyBrowserIdToken } from "./oidc-validation.js";
import { createTestSigningKey } from "./test/jwt-fixtures.js";

afterEach(() => vi.restoreAllMocks());
const issuer = "https://identity.example";
const redirectUri = "https://rp.example/callback";

it("rejects forged/default tokens without fetching message-supplied key metadata", async () => {
  const keys = await createTestSigningKey("ES256");
  const seen: string[] = [];
  const forged = `${btoa(JSON.stringify({ alg: "none", jku: "https://attacker.example/jwks" }))}.${btoa(JSON.stringify({ sub: "forged" }))}.x`;
  await expect(
    verifyBrowserIdToken({
      token: forged,
      nonce: "transaction-nonce",
      issuer,
      clientId: "rp",
      jwksUri: `${issuer}/jwks`,
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify(keys.jwks));
      },
    }),
  ).rejects.toThrow();
  expect(seen).toEqual([`${issuer}/jwks`]);
});

it("rejects missing mandatory claims, future issuance, not-before and ambiguous audiences", async () => {
  const keys = await createTestSigningKey("ES256");
  const now = Math.floor(Date.now() / 1000);
  const base: JsonObject = {
    sub: "user",
    iss: issuer,
    aud: "rp",
    nonce: "nonce",
    iat: now,
    exp: now + 300,
  };
  const cases: JsonObject[] = [
    ...["sub", "iss", "aud", "nonce", "iat", "exp"].map((name) =>
      Object.fromEntries(Object.entries(base).filter(([key]) => key !== name)),
    ),
    { ...base, iat: now + 60 },
    { ...base, nbf: now + 60 },
    { ...base, aud: ["rp", "another"] },
    { ...base, azp: "another" },
  ];
  for (const claims of cases) {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "test-signing-key" })
      .sign(keys.privateKey);
    await expect(
      verifyBrowserIdToken({
        token,
        nonce: "nonce",
        issuer,
        clientId: "rp",
        jwksUri: `${issuer}/jwks`,
        fetchImpl: async () => new Response(JSON.stringify(keys.jwks)),
      }),
    ).rejects.toThrow();
  }
});

it("bounds discovery/JWKS/token bytes and refuses redirect responses", async () => {
  const seen: RequestInit[] = [];
  await expect(
    fetchOidcJson(async (_input, init) => {
      if (init) seen.push(init);
      return new Response("x".repeat(262145));
    }, `${issuer}/jwks`),
  ).rejects.toThrow(/too large/);
  expect(seen[0]).toMatchObject({
    redirect: "error",
    credentials: "omit",
    cache: "no-store",
  });
  await expect(
    fetchOidcJson(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example" },
        }),
      `${issuer}/jwks`,
    ),
  ).rejects.toThrow(/refused/);
  await expect(
    verifyBrowserIdToken({
      token: "a.b.c",
      nonce: "nonce",
      issuer,
      clientId: "rp",
      jwksUri: `${issuer}/jwks`,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ keys: Array.from({ length: 33 }, () => ({})) }),
        ),
    }),
  ).rejects.toThrow(/key count/);
});

it("cancels a stalled response body when its request deadline expires", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  let cancelled = false;
  const result = fetchOidcJson(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    `${issuer}/jwks`,
  );
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  await expect(result).rejects.toThrow();
  expect(cancelled).toBe(true);
});

it("rejects private key remnants, remote references, duplicate identifiers and caller cancellation", async () => {
  const keys = await createTestSigningKey("ES256");
  for (const field of ["p", "q", "dp", "dq", "qi", "oth", "jku", "x5u"]) {
    await expect(
      verifyBrowserIdToken({
        token: "a.b.c",
        nonce: "nonce",
        issuer,
        clientId: "rp",
        jwksUri: `${issuer}/jwks`,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              keys: [{ ...keys.publicJwk, [field]: "forbidden" }],
            }),
          ),
      }),
    ).rejects.toThrow(/public keys/);
  }
  await expect(
    verifyBrowserIdToken({
      token: "a.b.c",
      nonce: "nonce",
      issuer,
      clientId: "rp",
      jwksUri: `${issuer}/jwks`,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ keys: [keys.publicJwk, keys.publicJwk] }),
        ),
    }),
  ).rejects.toThrow(/duplicate/);
  const controller = new AbortController();
  controller.abort();
  await expect(
    fetchOidcJson(
      async (_input, init) => {
        init?.signal?.throwIfAborted();
        return Response.json({});
      },
      `${issuer}/jwks`,
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
});

it("binds the callback to exact issuer, redirect, age and unambiguous response fields", () => {
  const tx = {
    state: "state",
    codeVerifier: "verifier",
    nonce: "nonce",
    issuer,
    redirectUri,
    createdAt: Date.now(),
  };
  const callback = new URL(
    `${redirectUri}?code=code&state=state&iss=${encodeURIComponent(issuer)}`,
  );
  expect(() =>
    assertCallbackTransaction(tx, callback, issuer, redirectUri),
  ).not.toThrow();
  for (const altered of [
    { ...tx, issuer: "https://other.example" },
    { ...tx, createdAt: Date.now() - 300001 },
    { ...tx, createdAt: Date.now() + 60000 },
  ])
    expect(() =>
      assertCallbackTransaction(altered, callback, issuer, redirectUri),
    ).toThrow();
  expect(() =>
    assertCallbackTransaction(
      tx,
      new URL(`${callback}&code=second`),
      issuer,
      redirectUri,
    ),
  ).toThrow(/Ambiguous/);
  expect(() =>
    assertCallbackTransaction(
      tx,
      new URL("https://other.example/callback?code=x&state=state"),
      issuer,
      redirectUri,
    ),
  ).toThrow(/redirect/);
});
