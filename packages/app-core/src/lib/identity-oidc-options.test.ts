import { expect, it } from "vitest";
import {
  OIDC_NATIVE_FIELDS,
  configuredOidcClientOptions,
  isNativeOidcConfiguration,
  usesNativeOidcTransport,
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

it("advanced public protocol fields use browser HTTP without implying a configured node", () => {
  const publicClient = {
    protocol: "oidc",
    clientSecret: "",
    organizationId: "",
  };
  for (const fields of [
    { oidcTokenAuthentication: "none" as const },
    { organizationId: "org_registered" },
    { oidcAuthorizationEndpoint: "https://idp.example.test/authorize" },
    { oidcTokenEndpoint: "https://idp.example.test/token" },
    { oidcTransport: "browser" as const },
  ]) {
    const draft = { ...publicClient, ...fields };
    expect(isNativeOidcConfiguration(draft)).toBe(true);
    expect(usesNativeOidcTransport(draft)).toBe(false);
  }
  expect(isNativeOidcConfiguration(publicClient)).toBe(false);
  expect(usesNativeOidcTransport(publicClient)).toBe(false);
});

it("only the selected route or confidential auto compatibility selects the native carrier", () => {
  expect(OIDC_NATIVE_FIELDS.oidcTransport.parse("browser")).toBe("browser");
  expect(OIDC_NATIVE_FIELDS.oidcTransport.parse(undefined)).toBe("auto");
  expect(
    usesNativeOidcTransport({ clientSecret: "", oidcTransport: "native" }),
  ).toBe(true);
  expect(
    usesNativeOidcTransport({
      clientSecret: "",
      oidcClientType: "confidential",
    }),
  ).toBe(true);
  expect(
    usesNativeOidcTransport({ clientSecret: "sealed-existing-secret" }),
  ).toBe(true);
  expect(
    usesNativeOidcTransport({
      clientSecret: "sealed-existing-secret",
      oidcTransport: "browser",
    }),
  ).toBe(false);
  expect(() => OIDC_NATIVE_FIELDS.oidcTransport.parse("relay")).toThrow();
});
