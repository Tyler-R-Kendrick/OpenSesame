import type { BoundaryValue } from "@opensesame/os-domain";
import { beforeAll, expect, it, vi } from "vitest";
import type {
  NativeConfiguration,
  NativePending,
} from "./native-connector-schema.js";
import {
  nativeTenantOAuthEndpoints,
  verifyNativeTenantOAuthIdentity,
} from "./native-tenant-oauth.js";

let keys: CryptoKeyPair;
let publicKey: JsonWebKey;
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
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const encoded = (value: BoundaryValue) =>
  base64(new TextEncoder().encode(JSON.stringify(value)));
const cases = [
  {
    provider: "auth0" as const,
    domain: "own-tenant.us.auth0.com",
    subject: "auth0|actual-user",
    account: {
      sub: "auth0|actual-user",
      email: "owner@example.test",
      name: "Auth0 owner",
    },
    label: "Auth0 owner",
  },
  {
    provider: "okta" as const,
    domain: "own-tenant.okta.com",
    subject: "00uActualUser",
    account: { id: "00uActualUser", profile: { login: "owner@example.test" } },
    label: "owner@example.test",
  },
];
function transaction(provider: "auth0" | "okta", domain: string) {
  const endpoints = nativeTenantOAuthEndpoints(provider, domain);
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: provider,
    method: "oauth",
    displayName: "Own tenant",
    icon: "",
    parameters: { domain },
    clientId: "public-spa-client",
    requestedScopes: { user: ["openid"] },
    targetIds: {},
    fingerprint: "a".repeat(64),
  };
  const pending: NativePending = {
    providerId: provider,
    actor: "user",
    fingerprint: configuration.fingerprint,
    issuer: endpoints.issuer,
    endpoint: endpoints.token,
    clientId: configuration.clientId,
    state: "s".repeat(43),
    verifier: "v".repeat(43),
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    scopes: ["openid"],
  };
  return { endpoints, configuration, pending };
}
async function grant(issuer: string, subject: string, nonce = "s".repeat(43)) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${encoded({ alg: "RS256", kid: "tenant-key", typ: "JWT" })}.${encoded({ iss: issuer, sub: subject, aud: "public-spa-client", iat: now, exp: now + 3600, nonce })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(data),
  );
  return {
    accessToken: "private-tenant-access",
    refreshToken: "private-tenant-refresh",
    expiresAt: Date.now() + 3600_000,
    scopes: ["openid"],
    protocolValid: true,
    idToken: `${data}.${base64(new Uint8Array(signature))}`,
  };
}
it.each(cases)(
  "$provider verifies a signed tenant identity and the granted provider resource",
  async ({ provider, domain, subject, account, label }) => {
    const { endpoints, configuration, pending } = transaction(provider, domain);
    const fetch = vi.fn(
      async (url: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(url) === endpoints.jwks
              ? {
                  keys: [
                    {
                      ...publicKey,
                      kid: "tenant-key",
                      alg: "RS256",
                      use: "sig",
                    },
                  ],
                }
              : account,
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const identity = await verifyNativeTenantOAuthIdentity(
      configuration,
      pending,
      await grant(endpoints.issuer, subject),
      { fetch, assertCurrent: vi.fn() },
    );
    expect(identity.id).toBe(subject);
    expect(identity.label).toBe(label);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      endpoints.jwks,
      endpoints.userinfo,
    ]);
    expect(JSON.stringify(identity)).not.toContain("private-tenant");
  },
);
it.each([
  "tenant.auth0.com.attacker.example",
  "https://tenant.auth0.com",
  "tenant.auth0.com/path",
  "tenant..auth0.com",
  "127.0.0.1",
  "tenant.okta.com@attacker.example",
  "tenant.okta.com?redirect=other",
])("refuses a tenant host that escapes the approved provider: %s", (domain) => {
  expect(() => nativeTenantOAuthEndpoints("auth0", domain)).toThrow();
  expect(() => nativeTenantOAuthEndpoints("okta", domain)).toThrow();
});
it.each(cases)(
  "$provider refuses another tenant's pending code before fetching any endpoint",
  async ({ provider, domain, subject }) => {
    const { endpoints, configuration, pending } = transaction(provider, domain);
    const fetch = vi.fn();
    await expect(
      verifyNativeTenantOAuthIdentity(
        configuration,
        { ...pending, issuer: "https://different-tenant.example" },
        await grant(endpoints.issuer, subject),
        { fetch, assertCurrent: vi.fn() },
      ),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  },
);
it.each(cases)(
  "$provider refuses a valid signed assertion with another popup's nonce",
  async ({ provider, domain, subject }) => {
    const { endpoints, configuration, pending } = transaction(provider, domain);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            keys: [
              { ...publicKey, kid: "tenant-key", alg: "RS256", use: "sig" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    await expect(
      verifyNativeTenantOAuthIdentity(
        configuration,
        pending,
        await grant(endpoints.issuer, subject, "other-session"),
        { fetch, assertCurrent: vi.fn() },
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
