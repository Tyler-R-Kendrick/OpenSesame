import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  issueServiceAgentIdentityAssertion,
  peekAssertionTyp,
  verifyServiceAgentIdentityAssertion,
} from "./assertion.js";
import { PROVIDER_ID_JAG_TYP, SERVICE_ASSERTION_TYP } from "./constants.js";
import { AgentAuthError } from "./errors.js";

describe("service agent identity assertion", () => {
  it.each(["", "not-a-jwt", "bnVsbA.e30.signature", "W10.e30.signature"])(
    "rejects malformed headers before resolving a verification key: %s",
    async (jwt) => {
      let keyRequested = false;
      await expect(
        verifyServiceAgentIdentityAssertion(jwt, {
          issuer: "https://issuer.example",
          audience: "https://issuer.example",
          getKey: async () => {
            keyRequested = true;
            throw new Error("unexpected key lookup");
          },
        }),
      ).rejects.toBeInstanceOf(AgentAuthError);
      expect(keyRequested).toBe(false);
      expect(peekAssertionTyp(jwt)).toBeUndefined();
    },
  );

  it("round-trips os-sia+jwt and rejects an ID-JAG", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const key = {
      privateKey,
      publicJwk,
      kid: "k1",
      alg: "ES256" as const,
    };
    const issued = await issueServiceAgentIdentityAssertion(key, {
      issuer: "http://127.0.0.1:8788",
      audience: "http://127.0.0.1:8788",
      registrationId: "areg_abc",
      claimed: false,
      assertionVersion: 1,
      scopes: ["resource:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(peekAssertionTyp(issued.jwt)).toBe(SERVICE_ASSERTION_TYP);
    const verified = await verifyServiceAgentIdentityAssertion(issued.jwt, {
      issuer: "http://127.0.0.1:8788",
      audience: "http://127.0.0.1:8788",
      getKey: async () => publicKey,
    });
    expect(verified.sub).toBe("areg_abc");
    expect(verified.os_claimed).toBe(false);
    const idJag = await new SignJWT({ sub: "areg_abc" })
      .setProtectedHeader({ alg: "ES256", typ: PROVIDER_ID_JAG_TYP })
      .setIssuer("http://127.0.0.1:8788")
      .setAudience("http://127.0.0.1:8788")
      .setExpirationTime("5m")
      .sign(privateKey);
    await expect(
      verifyServiceAgentIdentityAssertion(idJag, {
        issuer: "http://127.0.0.1:8788",
        audience: "http://127.0.0.1:8788",
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);
  });

  it("requires the assertion to name the resource the exchange asks for", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const key = {
      privateKey,
      publicJwk: await exportJWK(publicKey),
      kid: "k1",
      alg: "ES256" as const,
    };
    const withResource = await issueServiceAgentIdentityAssertion(key, {
      issuer: "https://issuer.example",
      audience: "https://issuer.example",
      registrationId: "areg_abc",
      claimed: false,
      assertionVersion: 1,
      scopes: ["resource:read"],
      expiresAt: new Date(Date.now() + 60_000),
      resource: "https://api.example",
    });
    await expect(
      verifyServiceAgentIdentityAssertion(withResource.jwt, {
        issuer: "https://issuer.example",
        audience: "https://issuer.example",
        resource: "https://api.example",
        getKey: async () => publicKey,
      }),
    ).resolves.toMatchObject({ resource: "https://api.example" });
    await expect(
      verifyServiceAgentIdentityAssertion(withResource.jwt, {
        issuer: "https://issuer.example",
        audience: "https://issuer.example",
        resource: "https://other.example",
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);

    const withoutResource = await issueServiceAgentIdentityAssertion(key, {
      issuer: "https://issuer.example",
      audience: "https://issuer.example",
      registrationId: "areg_abc",
      claimed: false,
      assertionVersion: 1,
      scopes: ["resource:read"],
      expiresAt: new Date(Date.now() + 60_000),
    });
    // A missing resource claim is not a wildcard when the caller pinned one.
    await expect(
      verifyServiceAgentIdentityAssertion(withoutResource.jwt, {
        issuer: "https://issuer.example",
        audience: "https://issuer.example",
        resource: "https://api.example",
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);

    // The metadata advertises the slash form; it still names this resource.
    await expect(
      verifyServiceAgentIdentityAssertion(withResource.jwt, {
        issuer: "https://issuer.example",
        audience: "https://issuer.example",
        resource: "https://api.example/",
        getKey: async () => publicKey,
      }),
    ).resolves.toMatchObject({ resource: "https://api.example" });
  });

  it.each([
    ["https://api.example///", "https://api.example/", true],
    ["///", "/", true],
    ["", "/", true],
    ["https://api.example/a/b", "https://api.example/ab", false],
    [
      "https://api.example/",
      `https://api.example/${"/".repeat(100_000)}x`,
      false,
    ],
    [
      `https://api.example/${"/".repeat(100_000)}x`,
      "https://api.example/",
      false,
    ],
  ])(
    "compares resource suffixes without backtracking (case %#)",
    async (resource, expectedResource, matches) => {
      const { privateKey, publicKey } = await generateKeyPair("ES256");
      const issued = await issueServiceAgentIdentityAssertion(
        { privateKey, publicJwk: {}, kid: "k1", alg: "ES256" },
        {
          issuer: "https://issuer.example",
          audience: "https://issuer.example",
          registrationId: "areg_abc",
          claimed: false,
          assertionVersion: 1,
          scopes: [],
          expiresAt: new Date(Date.now() + 60_000),
          resource,
        },
      );
      const started = performance.now();
      const verified = verifyServiceAgentIdentityAssertion(issued.jwt, {
        issuer: "https://issuer.example",
        audience: "https://issuer.example",
        resource: expectedResource,
        getKey: async () => publicKey,
      });
      if (matches) await expect(verified).resolves.toMatchObject({ resource });
      else await expect(verified).rejects.toBeInstanceOf(AgentAuthError);
      // A reverse scan finishes well below this generous bound; quadratic
      // retries over the attacker-controlled slash run take several seconds.
      expect(performance.now() - started).toBeLessThan(1_000);
    },
  );

  it("requires exp, iat and jti rather than accepting a non-expiring assertion", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: "https://issuer.example",
      aud: "https://issuer.example",
      sub: "areg_abc",
      jti: "jti-1",
      iat: now,
      os_reg: "areg_abc",
      os_claimed: false,
      os_av: 1,
      scope: "resource:read",
    })
      .setProtectedHeader({ alg: "ES256", typ: SERVICE_ASSERTION_TYP })
      .sign(privateKey);
    await expect(
      verifyServiceAgentIdentityAssertion(token, {
        issuer: "https://issuer.example",
        audience: "https://issuer.example",
        getKey: async () => publicKey,
      }),
    ).rejects.toBeInstanceOf(AgentAuthError);
  });
});
