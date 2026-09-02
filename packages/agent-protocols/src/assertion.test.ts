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
});
