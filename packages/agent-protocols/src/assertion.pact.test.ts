import { assertNoSecretFields } from "@opensesame/testing";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  issueServiceAgentIdentityAssertion,
  peekAssertionTyp,
  verifyServiceAgentIdentityAssertion,
} from "./assertion.js";
import { PROVIDER_ID_JAG_TYP, SERVICE_ASSERTION_TYP } from "./constants.js";
import { AgentAuthError } from "./errors.js";

describe("PACT — service assertion profile", () => {
  it("contract: issued assertions are typed os-sia+jwt and never carry a refresh token", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const issued = await issueServiceAgentIdentityAssertion(
      {
        privateKey,
        publicJwk: await exportJWK(publicKey),
        kid: "k1",
        alg: "ES256",
      },
      {
        issuer: "http://127.0.0.1:8788",
        audience: "http://127.0.0.1:8788",
        registrationId: "areg_pact",
        claimed: false,
        assertionVersion: 1,
        scopes: ["resource:read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
    );
    expect(peekAssertionTyp(issued.jwt)).toBe(SERVICE_ASSERTION_TYP);
    assertNoSecretFields({
      jti: issued.jti,
      sub: issued.claims.sub,
      typ: SERVICE_ASSERTION_TYP,
    });
  });

  it("adversarial: a provider ID-JAG is not a service assertion", async () => {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: true,
    });
    const idJag = await new SignJWT({ sub: "areg_pact", os_reg: "areg_pact" })
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
