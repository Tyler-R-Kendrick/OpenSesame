import { describe, expect, it } from "vitest";
import {
  ClientAdmissionError,
  createClientAdmissionPolicy,
  defaultAdmissionFromEnv,
} from "../clients/admission.js";
import type { ClientAdmissionMode, OAuthClientRecord } from "../types.js";

const flags = {
  originClientsEnabled: true,
  dcrEnabled: true,
  cimdEnabled: true,
};

const activeClient: OAuthClientRecord = {
  id: "client-1",
  admissionMode: "pre_registered",
  displayName: "Client One",
  redirectUris: ["https://app.example/cb"],
  sectorIdentifier: "app.example",
  grantTypes: ["authorization_code"],
  responseTypes: ["code"],
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
  allowedResources: [],
  state: "active",
};

describe("client admission policy", () => {
  it("rejects suspended and revoked clients before any mode checks", () => {
    const policy = createClientAdmissionPolicy(flags);
    for (const state of ["suspended", "revoked"] as const) {
      try {
        policy.assertAdmissible({ ...activeClient, state });
        expect.unreachable("must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ClientAdmissionError);
        expect((err as ClientAdmissionError).code).toBe("client_inactive");
        expect((err as ClientAdmissionError).name).toBe("ClientAdmissionError");
        expect((err as Error).message).toContain(state);
      }
    }
  });

  it("rejects clients whose admission mode is disabled", () => {
    const policy = createClientAdmissionPolicy({
      originClientsEnabled: false,
      dcrEnabled: false,
      cimdEnabled: false,
    });
    try {
      policy.assertAdmissible({
        ...activeClient,
        admissionMode: "dynamic_registration",
      });
      expect.unreachable("must throw");
    } catch (err) {
      expect((err as ClientAdmissionError).code).toBe(
        "admission_mode_disabled",
      );
    }
  });

  it("enables each mode only under its own flag", () => {
    const all = createClientAdmissionPolicy(flags);
    expect(all.isModeEnabled("pre_registered")).toBe(true);
    expect(all.isModeEnabled("origin_profile")).toBe(true);
    expect(all.isModeEnabled("dynamic_registration")).toBe(true);
    expect(all.isModeEnabled("client_metadata_document")).toBe(true);
  });

  it("returns the input for unknown modes at runtime", () => {
    const policy = createClientAdmissionPolicy(flags);
    const bogus = "not_a_mode" as unknown as ClientAdmissionMode;
    expect(policy.isModeEnabled(bogus)).toBe("not_a_mode");
  });

  it("requires origin-profile clients to declare an origin", () => {
    const policy = createClientAdmissionPolicy(flags);
    try {
      policy.assertAdmissible({
        ...activeClient,
        admissionMode: "origin_profile",
      });
      expect.unreachable("must throw");
    } catch (err) {
      expect((err as ClientAdmissionError).code).toBe("origin_required");
    }
  });

  it("rejects every forbidden origin scope", () => {
    const policy = createClientAdmissionPolicy(flags);
    for (const scope of ["offline_access", "admin", "opensesame.admin"]) {
      expect(() => policy.assertOriginScopes([scope]), scope).toThrow(
        ClientAdmissionError,
      );
    }
    expect(() =>
      policy.assertOriginScopes(["openid", "profile"]),
    ).not.toThrow();
  });

  it("builds a default policy from the provider env", () => {
    const policy = defaultAdmissionFromEnv({
      originClientsEnabled: false,
      dcrEnabled: false,
      cimdEnabled: false,
      issuer: "https://id.example.test",
      allowedResources: [],
      isProduction: false,
    });
    expect(policy.isModeEnabled("pre_registered")).toBe(true);
    expect(policy.isModeEnabled("dynamic_registration")).toBe(false);
  });
});
