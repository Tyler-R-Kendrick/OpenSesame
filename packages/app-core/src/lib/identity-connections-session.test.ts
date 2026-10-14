import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import {
  identitySessionAudience,
  identitySessionIssuer,
  identitySessionJwksUri,
  logoutIdentitySession,
  signInIdentitySession,
  testIdentitySession,
} from "./identity-connections-session.js";

import {
  betterAuthFixture,
  email,
  password,
  supabaseFixture,
} from "./identity-connections-session.test-support.js";
afterEach(() => vi.unstubAllGlobals());

describe("real Better Auth native identity sessions", () => {
  it("signs in, verifies the session-bound JWT against real keys, and revokes the cookie", async () => {
    const fixture = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    expect(identitySessionIssuer(draft)).toBe(fixture.baseURL);
    expect(identitySessionAudience(draft)).toBe(fixture.baseURL);
    expect(await testIdentitySession(draft)).toEqual({
      message: expect.stringContaining("signing keys"),
    });
    const identity = await signInIdentitySession(draft, { email, password });
    expect(identity).toMatchObject({
      issuer: fixture.baseURL,
      audience: fixture.baseURL,
      email,
      name: "Identity User",
    });
    expect(identity.pairwiseSub).toBeTruthy();
    expect(identity.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(identity)).not.toContain(password);
    expect(
      fixture.requests.filter((request) =>
        /sign-in\/email|get-session|\/token$/.test(request.url),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          init: expect.objectContaining({ credentials: "include" }),
        }),
      ]),
    );
    await logoutIdentitySession(draft);
    await expect(
      signInIdentitySession(draft, { email, password: "incorrect-password" }),
    ).rejects.toThrow("401");
  });

  it("uses the same native adapter for Neon and configurable issuer/audience/JWKS", async () => {
    const { baseURL } = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("neon-auth"),
      baseUrl: `${baseURL}/api/auth`,
      issuer: baseURL,
      audience: baseURL,
      jwksUri: `${baseURL}/api/auth/jwks`,
    };
    const identity = await signInIdentitySession(draft, { email, password });
    expect(identity.upstreamId).toBe("neon-auth");
    expect(identity.jwksUri).toBe(draft.jwksUri);
  });

  it("derives Neon managed JWT defaults from its documented branch URL", () => {
    const draft = {
      ...identityConnectionDraft("neon-auth"),
      baseUrl: "https://ep-neon.neonauth.us-east-1.aws.neon.tech/neondb/auth",
    };
    expect(identitySessionIssuer(draft)).toBe(
      "https://ep-neon.neonauth.us-east-1.aws.neon.tech",
    );
    expect(identitySessionAudience(draft)).toBe(identitySessionIssuer(draft));
    expect(identitySessionJwksUri(draft)).toBe(
      `${draft.baseUrl}/.well-known/jwks.json`,
    );
  });

  it("rejects a session with an identity different from its signed token", async () => {
    const fixture = await betterAuthFixture();
    const realFetch = fixture.fetchMock;
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const response = await realFetch(input, init);
      if (!input.includes("/get-session")) return response;
      const session = await response.json();
      return Response.json({
        ...session,
        user: { ...session.user, id: "another-user" },
      });
    });
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    await expect(
      signInIdentitySession(draft, { email, password }),
    ).rejects.toThrow("does not match");
  });

  it("rejects an expired provider session before requesting a token", async () => {
    const fixture = await betterAuthFixture();
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const response = await fixture.fetchMock(input, init);
      if (!input.includes("/get-session")) return response;
      const session = await response.json();
      return Response.json({
        ...session,
        session: { ...session.session, expiresAt: "2000-01-01T00:00:00Z" },
      });
    });
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    await expect(
      signInIdentitySession(draft, { email, password }),
    ).rejects.toThrow("expired session");
    expect(
      fixture.requests.some((request) => request.url.endsWith("/token")),
    ).toBe(false);
  });

  it("rejects a JWT from the wrong audience", async () => {
    const { baseURL } = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${baseURL}/api/auth`,
      audience: "another-application",
    };
    await expect(
      signInIdentitySession(draft, { email, password }),
    ).rejects.toThrow('"aud"');
  });

  it("rejects a forged assertion even when its identity matches the live session", async () => {
    const fixture = await betterAuthFixture();
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const response = await fixture.fetchMock(input, init);
      if (!input.endsWith("/token")) return response;
      const data = await response.json();
      const parts = data.token.split(".");
      const signature = parts[2];
      parts[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
      return Response.json({ token: parts.join(".") });
    });
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    await expect(
      signInIdentitySession(draft, { email, password }),
    ).rejects.toThrow("signature");
  });

  it("refuses credentials over insecure remote URLs or URLs containing credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const baseUrl of [
      "http://identity.example.com/api/auth",
      "https://username:password@identity.example.com/api/auth",
    ]) {
      await expect(
        signInIdentitySession(
          { ...identityConnectionDraft("better-auth"), baseUrl },
          { email, password },
        ),
      ).rejects.toThrow("HTTPS");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Supabase native identity session wire contract", () => {
  it("exchanges password transiently, verifies GET /user and JWKS, and signs out", async () => {
    const { draft, requests, token } = await supabaseFixture();
    expect(await testIdentitySession(draft)).toEqual({
      message: expect.stringContaining("settings are reachable"),
    });
    const identity = await signInIdentitySession(draft, { email, password });
    expect(identity).toMatchObject({
      issuer: "https://project.supabase.co/auth/v1",
      audience: "authenticated",
      pairwiseSub: "supabase-user",
      email,
    });
    expect(JSON.stringify(identity)).not.toContain(password);
    expect(
      requests.find((request) => request.url.endsWith("/user"))?.init,
    ).toMatchObject({
      credentials: "omit",
      headers: { apikey: draft.publicKey, Authorization: `Bearer ${token}` },
    });
    await logoutIdentitySession(draft, token);
    expect(requests.at(-1)?.url).toMatch(/logout\?scope=local$/);
  });

  it("validates legacy HS256 projects through authoritative GET /user", async () => {
    const { draft, requests } = await supabaseFixture({ legacy: true });
    expect(
      (await signInIdentitySession(draft, { email, password })).pairwiseSub,
    ).toBe("supabase-user");
    expect(requests.some((request) => request.url.endsWith("/user"))).toBe(
      true,
    );
    expect(requests.some((request) => request.url.includes("jwks"))).toBe(
      false,
    );
  });

  it.each([{ subject: "wrong-user" }, { expired: true }])(
    "rejects mismatched or expired identities %j",
    async (options) => {
      const { draft } = await supabaseFixture(options);
      await expect(
        signInIdentitySession(draft, { email, password }),
      ).rejects.toThrow();
    },
  );

  it("rejects browser exposure of secret and legacy service_role keys without a request", async () => {
    const { draft, requests } = await supabaseFixture();
    const serviceKey = await new SignJWT({ role: "service_role" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode("legacy-api-key-secret"));
    for (const publicKey of ["sb_secret_private", serviceKey]) {
      await expect(
        signInIdentitySession({ ...draft, publicKey }, { email, password }),
      ).rejects.toThrow(/publishable/);
    }
    expect(requests).toHaveLength(0);
  });

  it("honors configured custom endpoints, issuer, audience and signing key URL", () => {
    const draft = {
      ...identityConnectionDraft("byo-identity"),
      protocol: "supabase" as const,
      baseUrl: "https://self-hosted.example.com/auth/v1",
      issuer: "https://issuer.example.com",
      audience: "custom-audience",
      jwksUri: "https://keys.example.com/jwks.json",
    };
    expect(identitySessionIssuer(draft)).toBe(draft.issuer);
    expect(identitySessionAudience(draft)).toBe(draft.audience);
    expect(identitySessionJwksUri(draft)).toBe(draft.jwksUri);
  });
});
