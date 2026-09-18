import { describe, expect, it } from "vitest";
import {
  hostedClientToYaml,
  parseHostedApplicationSource,
} from "./hosted-application.js";

const client = {
  id: "cli_1",
  displayName: "RP",
  admissionMode: "pre_registered",
  state: "active",
  redirectUris: ["https://rp.example/cb"],
  sectorIdentifier: "https://rp.example",
  tokenEndpointAuthMethod: "none",
  allowedScopes: ["openid"],
  grantTypes: ["authorization_code"],
  createdAt: "",
  updatedAt: "",
};

describe("hosted application source", () => {
  it("round-trips and refuses ownerPrincipalId", () => {
    const yaml = hostedClientToYaml(client);
    const parsed = parseHostedApplicationSource(yaml, "cli_1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.displayName).toBe("RP");
    const stolen = parseHostedApplicationSource(
      `${yaml}ownerPrincipalId: prn_attacker\n`,
      "cli_1",
    );
    expect(stolen.ok).toBe(false);
  });
});
