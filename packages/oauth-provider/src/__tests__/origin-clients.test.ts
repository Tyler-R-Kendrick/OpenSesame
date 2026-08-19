import { describe, expect, it } from "vitest";
import {
  ClientAdmissionError,
  createClientAdmissionPolicy,
} from "../clients/admission.js";
import { createOpenSesameProvider } from "../create-provider.js";
import type { OAuthClientRecord } from "../types.js";

const baseClient: OAuthClientRecord = {
  id: "origin-app",
  admissionMode: "origin_profile",
  displayName: "Origin App",
  redirectUris: ["https://app.example/cb"],
  sectorIdentifier: "https://app.example",
  grantTypes: ["authorization_code"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
  allowedResources: [],
  state: "active",
  origin: "https://app.example",
};

describe("origin client restrictions", () => {
  it("rejects origin_profile when OPENSESAME_ORIGIN_CLIENTS_ENABLED is off", () => {
    const policy = createClientAdmissionPolicy({
      originClientsEnabled: false,
      dcrEnabled: false,
      cimdEnabled: false,
    });
    expect(policy.isModeEnabled("pre_registered")).toBe(true);
    expect(policy.isModeEnabled("origin_profile")).toBe(false);
    expect(policy.isModeEnabled("dynamic_registration")).toBe(false);
    expect(policy.isModeEnabled("client_metadata_document")).toBe(false);
    expect(() => policy.assertAdmissible(baseClient)).toThrow(
      ClientAdmissionError,
    );
  });

  it("allows origin_profile when enabled but forbids offline_access and client_credentials", () => {
    const policy = createClientAdmissionPolicy({
      originClientsEnabled: true,
      dcrEnabled: false,
      cimdEnabled: false,
    });
    expect(() => policy.assertAdmissible(baseClient)).not.toThrow();

    expect(() =>
      policy.assertAdmissible({
        ...baseClient,
        allowedScopes: ["openid", "offline_access"],
      }),
    ).toThrow(/offline_access/);

    expect(() =>
      policy.assertAdmissible({
        ...baseClient,
        grantTypes: ["authorization_code", "client_credentials"],
      }),
    ).toThrow(/client_credentials/);
  });

  it("keeps DCR disabled in provider config by default", () => {
    const bundle = createOpenSesameProvider({
      issuer: "http://127.0.0.1:3999",
      processEnv: {},
    });
    expect(bundle.env.dcrEnabled).toBe(false);
    expect(bundle.env.cimdEnabled).toBe(false);
    expect(bundle.env.originClientsEnabled).toBe(false);
    expect(bundle.configuration.features).toMatchObject({
      registration: { enabled: false },
    });
  });
});
