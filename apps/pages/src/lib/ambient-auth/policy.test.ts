/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  defaultAmbientAuthPolicy,
  resolveAmbientAuthPolicy,
} from "./policy.js";
import { protocolForIssuer, providerConnectionKey } from "./provider.js";

const entraIssuer =
  "https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffffffffffff/v2.0";
const entraClient = "public-client";
const entraKey = providerConnectionKey({
  protocol: "entra",
  issuer: entraIssuer,
  clientId: entraClient,
});
const entraIdp = {
  providerId: "microsoft",
  issuer: entraIssuer,
  clientId: entraClient,
  label: "Contoso",
};

describe("ambient auth policy", () => {
  it("POL-DEFAULT: fresh personal origin is disabled with no sweep", () => {
    const decision = resolveAmbientAuthPolicy({});
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("disabled");
    expect(decision.policy).toEqual(defaultAmbientAuthPolicy());
    expect(decision.connection).toBeNull();
  });

  it("POL-OPTIN: last method without opt-in is not consent", () => {
    const decision = resolveAmbientAuthPolicy({
      lastSignInMethod: "google",
      operatorProviders: [entraIdp],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("opt-in-missing");
  });

  it("POL-ENTERPRISE: one concrete Entra connection is eligible", () => {
    const decision = resolveAmbientAuthPolicy({
      runtime: {
        schemaVersion: 1,
        mode: "deployment-selected",
        selectedProviderKey: entraKey,
        allowedTransport: "silent-redirect",
      },
      operatorProviders: [entraIdp],
    });
    expect(decision.eligible).toBe(true);
    expect(decision.connection?.key).toBe(entraKey);
    expect(decision.connection?.protocol).toBe("entra");
    expect(decision.policy.mode).toBe("deployment-selected");
    expect(decision.policy.provenance).toBe("deployment-runtime");
  });

  it("POL-ENTERPRISE: deployment runtime providers do not need prior settings", () => {
    const decision = resolveAmbientAuthPolicy({
      runtime: {
        schemaVersion: 1,
        mode: "deployment-selected",
        selectedProviderKey: entraKey,
        allowedTransport: "silent-redirect",
      },
      operatorProviders: [entraIdp],
    });
    expect(decision.eligible).toBe(true);
    expect(decision.connection?.clientId).toBe(entraClient);
  });

  it("POL-REMOVED: remembered provider gone cannot initiate login", () => {
    const decision = resolveAmbientAuthPolicy({
      userPreference: {
        schemaVersion: 1,
        mode: "returning-opt-in",
        selectedProviderKey: entraKey,
      },
      operatorProviders: [],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("provider-removed");
  });

  it("POL-INJECT: attacker issuer/client in storage is not trusted", () => {
    const attacker = providerConnectionKey({
      protocol: "oidc",
      issuer: "https://attacker.example",
      clientId: "stolen",
    });
    const decision = resolveAmbientAuthPolicy({
      userPreference: {
        schemaVersion: 1,
        mode: "returning-opt-in",
        selectedProviderKey: attacker,
      },
      operatorProviders: [entraIdp],
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("provider-removed");
  });

  it("POL-CONFLICT: two providers without a selected key do not pick first", () => {
    const other = {
      providerId: "okta",
      issuer: "https://acme.okta.com",
      clientId: "okta-client",
      label: "Okta",
    };
    const decision = resolveAmbientAuthPolicy({
      runtime: {
        schemaVersion: 1,
        mode: "deployment-selected",
      },
      operatorProviders: [entraIdp, other],
    });
    expect(decision.eligible).toBe(false);
  });

  it("corrupt blobs fail closed without enabling SSO", () => {
    expect(
      resolveAmbientAuthPolicy({
        runtime: { schemaVersion: 99, mode: "deployment-selected" },
      }).eligible,
    ).toBe(false);
    expect(resolveAmbientAuthPolicy({ runtime: "not-json" }).eligible).toBe(
      false,
    );
  });

  it("Shoo is not silently treated as Entra", () => {
    expect(protocolForIssuer("https://shoo.dev", "shoo")).toBe("shoo");
  });
});
