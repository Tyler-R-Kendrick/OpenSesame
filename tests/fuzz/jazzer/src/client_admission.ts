import {
  type ClientAdmissionMode,
  type OAuthClientRecord,
  createClientAdmissionPolicy,
} from "@opensesame/oauth-provider";
import { FuzzedDataProvider } from "./provider.js";

const MODES: ClientAdmissionMode[] = [
  "pre_registered",
  "origin_profile",
  "dynamic_registration",
  "client_metadata_document",
];

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const policy = createClientAdmissionPolicy({
    originClientsEnabled: p.consumeBoolean(),
    dcrEnabled: p.consumeBoolean(),
    cimdEnabled: p.consumeBoolean(),
  });
  const mode =
    MODES[p.consumeIntegralInRange(0, MODES.length - 1)] ?? "pre_registered";
  const client: OAuthClientRecord = {
    id: "client_fuzz",
    admissionMode: mode,
    displayName: "fuzz",
    redirectUris: ["https://app.example/cb"],
    sectorIdentifier: "https://app.example",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: p.consumeString(32).split(" ").filter(Boolean),
    allowedResources: [],
    state: p.consumeBoolean() ? "active" : "suspended",
  };
  try {
    policy.assertAdmissible(client);
    if (client.state !== "active") {
      throw new Error("inactive client was admitted");
    }
    if (!policy.isModeEnabled(mode)) {
      throw new Error("disabled admission mode was admitted");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("was admitted")) {
      throw err;
    }
  }
}
