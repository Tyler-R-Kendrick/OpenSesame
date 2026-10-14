import { afterEach, describe, expect, it, vi } from "vitest";
import { identityConnectionDraft } from "./identity-connections-presets.js";
import {
  IdentitySessionUnavailableError,
  logoutIdentitySession,
  signInIdentitySession,
  verifyIdentitySessionAssertion,
} from "./identity-connections-session.js";
import {
  betterAuthFixture,
  email,
  password,
  supabaseFixture,
} from "./identity-connections-session.test-support.js";

afterEach(() => vi.unstubAllGlobals());

describe("native assertion restoration", () => {
  it("restores a real Better Auth signed assertion against the live cookie session", async () => {
    const fixture = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    const original = await signInIdentitySession(draft, { email, password });
    const restored = await verifyIdentitySessionAssertion(
      draft,
      original.idToken,
    );
    expect(restored.pairwiseSub).toBe(original.pairwiseSub);
    expect(restored.idToken).toBe(original.idToken);
    expect(fixture.requests.at(-2)?.url).toContain(
      "get-session?disableCookieCache=true",
    );
  });

  it("refuses a still-unexpired assertion when the provider cookie session was revoked", async () => {
    const fixture = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    const original = await signInIdentitySession(draft, { email, password });
    expect(original.expiresAt).toBeGreaterThan(Date.now());
    await logoutIdentitySession(draft);
    await expect(
      verifyIdentitySessionAssertion(draft, original.idToken),
    ).rejects.toThrow();
  });

  it("refuses a saved assertion when the browser's current provider account changed", async () => {
    const fixture = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    const original = await signInIdentitySession(draft, { email, password });
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const response = await fixture.fetchMock(input, init);
      if (!input.includes("/get-session")) return response;
      const current = await response.json();
      return Response.json({
        ...current,
        user: { ...current.user, id: "changed-account" },
      });
    });
    await expect(
      verifyIdentitySessionAssertion(draft, original.idToken),
    ).rejects.toThrow("does not match");
  });

  it("refuses restoration when the Better Auth provider session expired", async () => {
    const fixture = await betterAuthFixture();
    const draft = {
      ...identityConnectionDraft("better-auth"),
      baseUrl: `${fixture.baseURL}/api/auth`,
    };
    const original = await signInIdentitySession(draft, { email, password });
    vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
      const response = await fixture.fetchMock(input, init);
      if (!input.includes("/get-session")) return response;
      const current = await response.json();
      return Response.json({
        ...current,
        session: { ...current.session, expiresAt: "2000-01-01T00:00:00Z" },
      });
    });
    await expect(
      verifyIdentitySessionAssertion(draft, original.idToken),
    ).rejects.toThrow("expired session");
  });

  it.each([false, true])(
    "restores Supabase assertions with authoritative user verification (legacy=%s)",
    async (legacy) => {
      const { draft, token, requests } = await supabaseFixture({ legacy });
      const identity = await verifyIdentitySessionAssertion(draft, token);
      expect(identity.pairwiseSub).toBe("supabase-user");
      expect(
        requests.some((request) => request.url.includes("grant_type=password")),
      ).toBe(false);
      expect(requests.some((request) => request.url.endsWith("/user"))).toBe(
        true,
      );
    },
  );

  it("refuses a Supabase assertion when the Auth server rejects its bearer token", async () => {
    const { draft, token } = await supabaseFixture({ legacy: true });
    vi.stubGlobal("fetch", () => new Response(null, { status: 401 }));
    await expect(verifyIdentitySessionAssertion(draft, token)).rejects.toThrow(
      "401",
    );
  });

  it("distinguishes an unavailable provider from an authentication refusal", async () => {
    const { draft, token } = await supabaseFixture({ legacy: true });
    vi.stubGlobal("fetch", () => {
      throw new TypeError("Network request failed");
    });
    await expect(
      verifyIdentitySessionAssertion(draft, token),
    ).rejects.toBeInstanceOf(IdentitySessionUnavailableError);
  });

  it.each([{ subject: "changed-account" }, { expired: true, legacy: true }])(
    "refuses changed/expired Supabase assertions %j",
    async (options) => {
      const { draft, token } = await supabaseFixture(options);
      await expect(
        verifyIdentitySessionAssertion(draft, token),
      ).rejects.toThrow();
    },
  );
});
