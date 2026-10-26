import { afterEach, expect, it } from "vitest";
import {
  isOperatorIdpIssuer,
  operatorUpstream,
} from "./federation-operator.js";
import { type OperatorIdp, readOperatorIdp } from "./operator-idp-config.js";
import { loadSettings, settingsSeams } from "./settings.js";

const original = { ...settingsSeams };
afterEach(() => Object.assign(settingsSeams, original));
function native(): OperatorIdp {
  return {
    providerId: "byo-identity",
    label: "Company SAML",
    protocol: "saml",
    connectionId: "saml-fixture",
    issuer: "urn:example:idp",
    clientId: "urn:example:sp",
  };
}
it("retains configured SAML URI identity/SP identifiers and exact connection binding in public settings", () => {
  expect(readOperatorIdp(native())).toEqual(native());
});
it("preserves exact trailing slashes and ordinary query components of SAML entity identifiers", () => {
  const value = {
    ...native(),
    issuer: "https://idp.example.test/entity/?tenant=fixture",
    clientId: "https://pwa.example.test/sp/",
  };
  expect(readOperatorIdp(value)).toEqual(value);
});
it("permits standard HTTP-form SAML identifiers without treating them as HTTP transport endpoints", () => {
  expect(
    readOperatorIdp({
      ...native(),
      issuer: "http://adfs.example.test/adfs/services/trust",
    })?.issuer,
  ).toBe("http://adfs.example.test/adfs/services/trust");
});
it.each([
  ["no saved connection", { connectionId: "" }],
  ["missing IdP identifier", { issuer: "" }],
  ["relative IdP identifier", { issuer: "relative-entity" }],
  ["missing SP identifier", { clientId: "" }],
  ["executable identifier", { issuer: "javascript:alert(1)" }],
  ["control character identifier", { issuer: "urn:example:\nentity" }],
] as const)("rejects incomplete native public trust: %s", (_name, changed) => {
  expect(readOperatorIdp({ ...native(), ...changed })).toBeNull();
});
it.each([
  ["SAML", native()],
  [
    "native OIDC",
    {
      ...native(),
      protocol: "oidc",
      nativeIdentity: true,
      issuer: "https://identity.example.test",
    },
  ],
] satisfies [string, OperatorIdp][])(
  "never converts a saved %s provider into an OAuth discovery/code upstream",
  (_name, provider) => {
    expect(() => operatorUpstream(provider)).toThrow(
      "Use the saved native identity connection for this identity",
    );
  },
);
it.each(["saml", "oidc"] as const)(
  "refuses a false native marker at the %s settings boundary",
  (protocol) => {
    const provider: OperatorIdp = { ...native(), protocol };
    if (protocol === "oidc") {
      provider.issuer = "https://idp.example.test";
      provider.clientId = "public-client";
    }
    expect(readOperatorIdp(provider)).toEqual(provider);
    if (protocol === "oidc")
      expect(readOperatorIdp({ ...provider, nativeIdentity: true })).toEqual({
        ...provider,
        nativeIdentity: true,
      });
    expect(readOperatorIdp({ ...provider, nativeIdentity: false })).toBeNull();
  },
);
it("native SAML public trust cannot authorize a legacy persisted OIDC/opaque assertion", () => {
  const baseline = loadSettings();
  settingsSeams.loadSettings = () => ({
    ...baseline,
    signIn: { builtin: false, providers: [native()] },
  });
  expect(isOperatorIdpIssuer(native().issuer)).toBe(false);
});
it("preserves existing direct public OIDC issuer normalization and registration", () => {
  const oidc = {
    providerId: "auth0",
    label: "Company OIDC",
    issuer: "https://example.auth0.com/",
    clientId: "public-client",
  };
  expect(readOperatorIdp(oidc)?.issuer).toBe("https://example.auth0.com");
  expect(operatorUpstream(oidc).clientId).toBe("public-client");
  const baseline = loadSettings();
  settingsSeams.loadSettings = () => ({
    ...baseline,
    signIn: { builtin: false, providers: [oidc] },
  });
  expect(isOperatorIdpIssuer("https://example.auth0.com")).toBe(true);
});
it.each(["better-auth", "supabase"] as const)(
  "preserves the existing %s native public session configuration",
  (protocol) => {
    expect(
      readOperatorIdp({
        providerId: protocol,
        protocol,
        connectionId: "session-fixture",
        issuer: "https://auth.example.test",
        clientId: "fixture-audience",
        label: "Session identity",
      })?.protocol,
    ).toBe(protocol);
  },
);
