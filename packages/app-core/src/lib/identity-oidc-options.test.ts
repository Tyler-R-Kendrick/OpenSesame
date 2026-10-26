import { expect, it } from "vitest";
import {
  configuredOidcClientOptions,
  isNativeOidcConfiguration,
} from "./identity-oidc-config.js";

it("keeps native custom OIDC endpoint and authentication fields in the shared schema", () => {
  const options = configuredOidcClientOptions({
    oidcAuthorizationEndpoint: "https://issuer.example/authorize",
    oidcTokenEndpoint: "https://issuer.example/token",
    jwksUri: "https://issuer.example/jwks",
    oidcTokenAuthentication: "client_secret_post",
  });
  expect(options.authentication).toBe("client_secret_post");
  expect(options.endpoints).toEqual({
    authorizationEndpoint: "https://issuer.example/authorize",
    tokenEndpoint: "https://issuer.example/token",
    jwksUri: "https://issuer.example/jwks",
  });
  expect(Object.isFrozen(options.endpoints)).toBe(true);
  expect(
    isNativeOidcConfiguration({
      protocol: "oidc",
      clientSecret: "",
      organizationId: "",
      oidcTransport: "native",
    }),
  ).toBe(true);
  expect(
    isNativeOidcConfiguration({
      protocol: "oidc",
      clientSecret: "",
      organizationId: "",
      oidcTokenEndpoint: "https://issuer.example/token",
    }),
  ).toBe(true);
  expect(
    isNativeOidcConfiguration({
      protocol: "oidc",
      clientSecret: "",
      organizationId: "",
    }),
  ).toBe(false);
});

it("keeps an existing public client's verification JWKS on its existing route", () => {
  const publicDraft = {
    protocol: "oidc",
    clientSecret: "",
    organizationId: "",
    jwksUri: "https://issuer.example/jwks",
  };
  expect(isNativeOidcConfiguration(publicDraft)).toBe(false);
});
