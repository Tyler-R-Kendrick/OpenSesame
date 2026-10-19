/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { configuredIdentitySessionTrusted } from "./federation-configured-token.js";
import { isOperatorIdpIssuer } from "./federation-operator.js";
import {
  readStoredSessionSync,
  restoreAuthenticatedSession,
} from "./federation-restoration.js";
import type { UpstreamIdentity } from "./federation.js";
import { loadSettings, settingsSeams } from "./settings.js";
import { buildSuccessMessage } from "./site-broker.js";

const original = { ...settingsSeams };
afterEach(() => Object.assign(settingsSeams, original));
function trust(protocol: "saml" | "oidc" | "better-auth" = "saml") {
  const baseline = loadSettings();
  settingsSeams.loadSettings = () => ({
    ...baseline,
    signIn: {
      builtin: false,
      providers: [
        {
          providerId: "byo-identity",
          label: "Company identity",
          protocol,
          connectionId: "fixture",
          issuer: "https://idp.example.test/entity/",
          clientId: "urn:example:sp",
        },
      ],
    },
  });
}
function identity(): UpstreamIdentity {
  return {
    issuer: "https://idp.example.test/entity/",
    upstreamId: "identity:fixture",
    idToken: "",
    assertionFormat: "saml",
    pairwiseSub: "saml:synthetic-policy-fixture",
    audience: "urn:example:sp",
    jwksUri: "",
    expiresAt: Date.now() + 60000,
  };
}
it("requires explicit native format plus exact issuer/audience for a configured SAML connection", () => {
  trust();
  expect(configuredIdentitySessionTrusted(identity())).toBe(true);
  expect(
    configuredIdentitySessionTrusted({
      ...identity(),
      issuer: "https://idp.example.test/entity",
    }),
  ).toBe(false);
  expect(
    configuredIdentitySessionTrusted({
      ...identity(),
      audience: "urn:foreign:sp",
    }),
  ).toBe(false);
  expect(
    configuredIdentitySessionTrusted({
      ...identity(),
      assertionFormat: "opaque",
    }),
  ).toBe(false);
});
it.each([true, false])(
  "mutable persisted SAML JSON cannot restore with format present=%s",
  async (withFormat) => {
    trust();
    const stored = { ...identity() };
    if (!withFormat) Reflect.deleteProperty(stored, "assertionFormat");
    const raw = JSON.stringify(stored);
    expect(readStoredSessionSync(raw, () => true)).toBeNull();
    const request = vi.fn<typeof fetch>();
    const result = await restoreAuthenticatedSession(
      raw,
      {
        issuer: stored.issuer,
        clientId: stored.audience,
        jwksUri: "https://idp.example.test/keys",
      },
      request,
    );
    expect(result).toEqual({ kind: "rejected", reason: "invalid" });
    expect(request).not.toHaveBeenCalled();
  },
);
it("unconfigured serialized SAML scalar claims are also refused before any provider request", async () => {
  const raw = JSON.stringify({
    ...identity(),
    upstreamId: "operator:unconfigured",
  });
  expect(readStoredSessionSync(raw, () => true)).toBeNull();
  const request = vi.fn<typeof fetch>();
  await expect(
    restoreAuthenticatedSession(
      raw,
      {
        issuer: identity().issuer,
        clientId: identity().audience,
        jwksUri: "https://idp.example.test/keys",
      },
      request,
    ),
  ).resolves.toEqual({ kind: "rejected", reason: "invalid" });
  expect(request).not.toHaveBeenCalled();
});
it("a native SAML issuer does not grant the legacy operator-token trust path", () => {
  trust();
  expect(isOperatorIdpIssuer(identity().issuer)).toBe(false);
  expect(
    readStoredSessionSync(
      JSON.stringify({
        ...identity(),
        upstreamId: "operator:fixture",
        assertionFormat: undefined,
      }),
      isOperatorIdpIssuer,
    ),
  ).toBeNull();
});
it.each(["oidc", "better-auth"] as const)(
  "retains existing %s configured opaque/token trust while refusing SAML substitution",
  (protocol) => {
    trust(protocol);
    expect(
      configuredIdentitySessionTrusted({
        ...identity(),
        assertionFormat: "opaque",
      }),
    ).toBe(true);
    expect(configuredIdentitySessionTrusted(identity())).toBe(false);
  },
);
it("does not forward a locally admitted SAML identity as an invented OIDC assertion", () => {
  const request = {
    clientId: "origin:http://localhost:5173",
    origin: "http://localhost:5173",
    state: "synthetic-policy-state",
    scope: "openid",
  };
  expect(() => buildSuccessMessage(request, identity())).toThrow(
    /assertion_format_mismatch/,
  );
  const existing = {
    ...identity(),
    assertionFormat: "opaque" as const,
    idToken: "actual-upstream-opaque-fixture",
  };
  expect(buildSuccessMessage(request, existing).id_token).toBe(
    existing.idToken,
  );
});
