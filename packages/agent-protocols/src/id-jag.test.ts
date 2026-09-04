import { SignJWT, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { PROVIDER_ID_JAG_TYP, SERVICE_ASSERTION_TYP } from "./constants.js";
import { AgentAuthError } from "./errors.js";
import { verifyProviderIdJag } from "./id-jag.js";

describe("verifyProviderIdJag", () => {
  async function mint(opts?: {
    typ?: string;
    alg?: "ES256";
    iss?: string;
    aud?: string;
    sub?: string;
    jti?: string;
    iatOffset?: number;
    expOffset?: number;
    authTimeOffset?: number;
    emailVerified?: boolean;
    omitAuthTime?: boolean;
  }) {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      sub: opts?.sub ?? "user_1",
      email: "user@example.com",
      email_verified: opts?.emailVerified ?? true,
    };
    if (!opts?.omitAuthTime) {
      claims.auth_time = now + (opts?.authTimeOffset ?? opts?.iatOffset ?? 0);
    }
    const jwt = await new SignJWT(claims)
      .setProtectedHeader({
        alg: "ES256",
        typ: opts?.typ ?? PROVIDER_ID_JAG_TYP,
      })
      .setIssuer(opts?.iss ?? "https://idp.example")
      .setAudience(opts?.aud ?? "http://127.0.0.1:8788")
      .setJti(opts?.jti ?? "jti-1")
      .setIssuedAt(now + (opts?.iatOffset ?? 0))
      .setExpirationTime(now + (opts?.expOffset ?? 300))
      .sign(privateKey);
    return { jwt, publicKey };
  }

  it("accepts a well-formed ID-JAG", async () => {
    const { jwt, publicKey } = await mint();
    const verified = await verifyProviderIdJag(jwt, {
      issuer: "https://idp.example",
      audiences: ["http://127.0.0.1:8788"],
      maxAgeSeconds: 600,
      maxAuthAgeSeconds: 3600,
      getKey: async () => publicKey,
    });
    expect(verified.subject).toBe("user_1");
    expect(verified.assertionId).toBe("jti-1");
    expect(verified.emailVerified).toBe(true);
  });

  it("rejects a service assertion typ", async () => {
    const { jwt, publicKey } = await mint({ typ: SERVICE_ASSERTION_TYP });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toMatchObject({ error: "invalid_request" });
  });

  it("rejects an ID token typ", async () => {
    const { jwt, publicKey } = await mint({ typ: "JWT" });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);
  });

  it("rejects the wrong audience", async () => {
    const { jwt, publicKey } = await mint({ aud: "https://other.example" });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);
  });

  it("rejects an assertion older than maxAgeSeconds", async () => {
    const { jwt, publicKey } = await mint({
      iatOffset: -10_000,
      expOffset: 300,
    });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 300,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toMatchObject({ error: "invalid_request" });
  });

  it("rejects an areg_ subject", async () => {
    const { jwt, publicKey } = await mint({ sub: "areg_not_a_user" });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);
  });

  it("rejects a missing auth_time with login_required", async () => {
    const { jwt, publicKey } = await mint({ omitAuthTime: true });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toMatchObject({ error: "login_required", status: 401 });
  });

  it("rejects a stale auth_time with login_required", async () => {
    const { jwt, publicKey } = await mint({ authTimeOffset: -10_000 });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toMatchObject({ error: "login_required", status: 401 });
  });

  it("rejects an unverified identity", async () => {
    const { jwt, publicKey } = await mint({ emailVerified: false });
    await expect(
      verifyProviderIdJag(jwt, {
        issuer: "https://idp.example",
        audiences: ["http://127.0.0.1:8788"],
        maxAgeSeconds: 600,
        maxAuthAgeSeconds: 3600,
        getKey: async () => publicKey,
      }),
    ).rejects.toMatchObject({ error: "invalid_request" });
  });
});
