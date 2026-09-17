import { afterEach, describe, expect, it } from "vitest";
import { resolveAmbientAuthPolicy } from "./policy.js";
import { providerConnectionKey } from "./provider.js";
import {
  applyDeployedAmbientPolicy,
  deployedAmbientPolicy,
  deployedAmbientProviders,
  resetDeployedAmbientPolicy,
} from "./runtime.js";

const issuer =
  "https://login.microsoftonline.com/aaaabbbb-cccc-dddd-eeee-ffffffffffff/v2.0";
const clientId = "public-client";

afterEach(() => {
  resetDeployedAmbientPolicy();
});

describe("deployed ambient runtime", () => {
  it("POL-ENTERPRISE: same-origin config supplies the provider allowlist", () => {
    applyDeployedAmbientPolicy({
      schemaVersion: 1,
      mode: "deployment-selected",
      selectedProviderKey: providerConnectionKey({
        protocol: "entra",
        issuer,
        clientId,
      }),
      allowedTransport: "silent-redirect",
      providers: [
        {
          providerId: "microsoft",
          issuer,
          clientId,
          label: "Contoso",
        },
      ],
    });
    const decision = resolveAmbientAuthPolicy({
      runtime: deployedAmbientPolicy(),
      operatorProviders: deployedAmbientProviders(),
    });
    expect(decision.eligible).toBe(true);
    expect(decision.connection?.displayName).toBe("Contoso");
  });

  it("POL-INJECT: incomplete provider records do not become trusted", () => {
    applyDeployedAmbientPolicy({
      schemaVersion: 1,
      mode: "deployment-selected",
      providers: [{ issuer: "https://attacker.example" }],
    });
    expect(deployedAmbientProviders()).toEqual([]);
  });
});
