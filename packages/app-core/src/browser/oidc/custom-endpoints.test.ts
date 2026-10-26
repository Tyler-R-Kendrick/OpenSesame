import { expect, it } from "vitest";
import { consumeNativeOidcProof } from "./claims.js";
import { tlsOracle } from "./tls.test-support.js";
import { prepareConfiguredOidc } from "./transaction.js";

const callback =
  "https://pwa.example.test/OpenSesame/auth/native-connector.html";

it.each(["client_secret_basic", "client_secret_post"] as const)(
  "configured endpoints use real TLS %s, S256 and issuer/audience/nonce-verified identity",
  async (authentication) => {
    const idp = await tlsOracle(authentication, "both");
    const input = {
      ...idp.config,
      authentication,
      endpoints: {
        authorizationEndpoint: `${idp.config.issuer}/authorize`,
        tokenEndpoint: `${idp.tokenBase}/token`,
        jwksUri: `${idp.jwksBase}/jwks`,
      },
    };
    const attempt = await prepareConfiguredOidc(
      input,
      callback,
      idp.transport,
      idp.owner,
    );
    expect(attempt.manualEndpoints).toBe(true);
    expect(idp.requests).toHaveLength(1);
    expect(idp.requests[0]?.path).toBe("/issuer/jwks");
    // The endpoint snapshot cannot be changed after the authorization request.
    input.endpoints.tokenEndpoint = "https://unapproved.example/token";
    idp.authorize(attempt.authorizationUrl);
    const proof = await attempt.complete({
      state: attempt.state,
      code: "independent-once",
      error: false,
    });
    expect(consumeNativeOidcProof(proof).claims).toMatchObject({
      issuer: idp.config.issuer,
      audience: idp.config.clientId,
      subject: "owned-person",
      organizationId: "org_actual",
    });
    await expect(
      attempt.complete({
        state: attempt.state,
        code: "independent-once",
        error: false,
      }),
    ).rejects.toThrow("already consumed");
    expect(idp.requests).toHaveLength(3);
    expect(idp.errors).toEqual([]);
  },
);

it("manual endpoints require explicit client authentication before any request", async () => {
  const idp = await tlsOracle("client_secret_basic");
  await expect(
    prepareConfiguredOidc(
      {
        ...idp.config,
        endpoints: {
          authorizationEndpoint: `${idp.config.issuer}/authorize`,
          tokenEndpoint: `${idp.tokenBase}/token`,
          jwksUri: `${idp.jwksBase}/jwks`,
        },
      },
      callback,
      idp.transport,
      idp.owner,
    ),
  ).rejects.toThrow("Select token authentication");
  expect(idp.requests).toHaveLength(0);
});

it("an unapproved delegated key endpoint cannot receive even a metadata request", async () => {
  const idp = await tlsOracle("client_secret_basic", "both");
  idp.withdraw(new URL(idp.jwksBase).origin);
  await expect(
    prepareConfiguredOidc(
      {
        ...idp.config,
        authentication: "client_secret_basic",
        endpoints: {
          authorizationEndpoint: `${idp.config.issuer}/authorize`,
          tokenEndpoint: `${idp.tokenBase}/token`,
          jwksUri: `${idp.jwksBase}/jwks`,
        },
      },
      callback,
      idp.transport,
      idp.owner,
    ),
  ).rejects.toThrow("original native route");
  expect(idp.requests).toHaveLength(0);
});

it("public authentication cannot spend a configured client secret", async () => {
  const idp = await tlsOracle("client_secret_basic");
  await expect(
    prepareConfiguredOidc(
      { ...idp.config, authentication: "none" },
      callback,
      idp.transport,
      idp.owner,
    ),
  ).rejects.toThrow("Match the token authentication");
  expect(idp.requests).toHaveLength(0);
});
