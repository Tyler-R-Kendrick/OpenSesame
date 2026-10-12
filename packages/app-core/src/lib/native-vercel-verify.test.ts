import type { BoundaryValue } from "@opensesame/os-domain";
import { beforeAll, expect, it, vi } from "vitest";
import type { IssuedNativeOAuthToken } from "./native-browser-oauth-token.js";
import type { NativeConfiguration } from "./native-connector-schema.js";
import { verifyNativeVercelIdentity } from "./native-vercel-verify.js";
import { vercelPending } from "./native-vercel.test-helper.js";

type ClaimChanges = { nonce?: string; aud?: string; iss?: string };
let keys: CryptoKeyPair;
let publicKey: JsonWebKey;
const configuration: NativeConfiguration = {
  version: 1,
  providerId: "vercel",
  method: "oauth",
  displayName: "Vercel identity",
  icon: "",
  parameters: {},
  clientId: "public-spa-client",
  requestedScopes: { user: ["openid", "email", "profile"] },
  targetIds: {},
  fingerprint: "a".repeat(64),
};
const encoded = (value: BoundaryValue) =>
  btoa(JSON.stringify(value))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  publicKey = await crypto.subtle.exportKey("jwk", keys.publicKey);
});
async function assertion(changed: ClaimChanges = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encoded({ alg: "RS256", kid: "provider-key", typ: "JWT" })}.${encoded(
    {
      iss: "https://vercel.com",
      aud: "public-spa-client",
      sub: "actual-vercel-user",
      iat: now,
      exp: now + 3600,
      nonce: vercelPending().state,
      ...changed,
    },
  )}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(input),
  );
  const suffix = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${input}.${suffix}`;
}
function authority(subject = "actual-vercel-user") {
  const fetch = vi.fn(
    async (url: RequestInfo | URL) =>
      new Response(
        JSON.stringify(
          String(url) === "https://vercel.com/.well-known/jwks"
            ? {
                keys: [
                  {
                    ...publicKey,
                    kid: "provider-key",
                    alg: "RS256",
                    use: "sig",
                  },
                ],
              }
            : {
                sub: subject,
                preferred_username: "Vercel owner",
                email: "owner@example.test",
              },
        ),
        { headers: { "content-type": "application/json" } },
      ),
  );
  return { fetch, assertCurrent: vi.fn() };
}
async function grant(
  changed: ClaimChanges = {},
): Promise<IssuedNativeOAuthToken> {
  return {
    accessToken: "private-vercel-access",
    refreshToken: "private-vercel-refresh",
    expiresAt: Date.now() + 3600_000,
    scopes: ["openid", "email", "profile"],
    idToken: await assertion(changed),
    protocolValid: true,
  };
}
it("authenticates a real signed assertion then checks the same provider account through userinfo", async () => {
  const transport = authority();
  const token = await grant();
  const identity = await verifyNativeVercelIdentity(
    configuration,
    vercelPending(),
    token,
    transport,
  );
  expect(identity).toEqual({
    id: "actual-vercel-user",
    label: "Vercel owner",
    kind: "identity-account",
    assurance: "account-verified",
  });
  expect(transport.fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://vercel.com/.well-known/jwks",
    "https://api.vercel.com/login/oauth/userinfo",
  ]);
  expect(JSON.stringify(identity)).not.toContain(token.accessToken);
});
const changedBindings: ClaimChanges[] = [
  { nonce: "another-transaction" },
  { aud: "other-client" },
  { iss: "https://attacker.example" },
];
it.each(changedBindings)(
  "refuses a valid signature with a mismatched initiating binding: %j",
  async (changed) => {
    const transport = authority();
    await expect(
      verifyNativeVercelIdentity(
        configuration,
        vercelPending(),
        await grant(changed),
        transport,
      ),
    ).rejects.toThrow();
    expect(transport.fetch).toHaveBeenCalledTimes(1);
  },
);
it("refuses an authenticated userinfo response belonging to another account", async () => {
  await expect(
    verifyNativeVercelIdentity(
      configuration,
      vercelPending(),
      await grant(),
      authority("another-user"),
    ),
  ).rejects.toThrow();
});
it("requires an ID token when first authorizing; a token alone cannot create account proof", async () => {
  const transport = authority();
  const token = await grant();
  token.idToken = undefined;
  await expect(
    verifyNativeVercelIdentity(
      configuration,
      vercelPending(),
      token,
      transport,
    ),
  ).rejects.toThrow();
  expect(transport.fetch).not.toHaveBeenCalled();
});
it("rejects a forged ID-token signature before using the bearer at userinfo", async () => {
  const transport = authority();
  const token = await grant();
  if (!token.idToken) throw new Error("Expected signed fixture");
  const [header, payload, signature] = token.idToken.split(".");
  if (!signature) throw new Error("Expected token signature");
  token.idToken = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  await expect(
    verifyNativeVercelIdentity(
      configuration,
      vercelPending(),
      token,
      transport,
    ),
  ).rejects.toThrow();
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});
