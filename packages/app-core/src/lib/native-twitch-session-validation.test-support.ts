/** HTTP and sealed-ledger fixtures for Twitch's runtime validation contract. */
import { vi } from "vitest";
import * as kv from "./kv.js";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import { emptyNativePrivate } from "./native-connector-schema.js";
import { saveNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export const validationClient = "public-validation-client";
export const validationAccess = "test-issued-validation-access-token";
export const validationReply = {
  client_id: validationClient,
  user_id: "12345",
  login: "engineer",
  scopes: ["user:read:email"],
  expires_in: 14400,
};
export function validationBackend(): void {
  kv.kvForgetAll();
  const values = new Map<string, string>();
  vi.spyOn(kv.kvSeams, "kvGet").mockImplementation(
    (key) => values.get(key) ?? null,
  );
  vi.spyOn(kv.kvSeams, "kvSetDurable").mockImplementation(
    async (key, value) => {
      values.set(key, value);
    },
  );
}
export async function saveValidationFixture(
  id = "twitch-validation",
  expiresAt = Date.now() + 4 * 60 * 60_000,
): Promise<string> {
  const fingerprint = "a".repeat(64);
  const privateState = emptyNativePrivate();
  privateState.verification = {
    fingerprint,
    verifiedAt: Date.now(),
    kind: "provider",
  };
  privateState.grants.user = {
    providerId: "twitch",
    actor: "user",
    fingerprint,
    kind: "oauth",
    accessToken: validationAccess,
    refreshToken: "test-issued-validation-refresh-token",
    expiresAt,
    scopes: validationReply.scopes,
    clientId: validationClient,
    issuer: "https://id.twitch.tv",
    endpoint: "https://id.twitch.tv/oauth2/token",
  };
  const configuration = {
    version: 1 as const,
    providerId: "twitch",
    method: "oauth" as const,
    displayName: "Twitch",
    icon: "",
    parameters: {},
    requestedScopes: { user: validationReply.scopes },
    targetIds: {},
    fingerprint,
    clientId: validationClient,
  };
  await saveNativeConnector(
    {
      connectionId: id,
      configuration,
      privateState,
      runtime: {
        verifiedAt: Date.now(),
        identity: {
          id: "12345",
          label: "Engineer",
          kind: "account",
          assurance: "account-verified",
        },
        targets: [],
        grants: [
          {
            actor: "user",
            label: "Engineer",
            permissionState: "known",
            grantedScopes: validationReply.scopes,
            expiresAt,
            needsReauth: false,
          },
        ],
      },
    },
    browserOAuthClassification(configuration),
  );
  return id;
}
export function validationTransport() {
  let active = true;
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json(validationReply),
  );
  const transport: NativeProviderTransport = {
    fetch: fetcher,
    assertCurrent: () => {
      if (!active) throw new Error("Capability disposed");
    },
  };
  return {
    fetcher,
    transport,
    dispose: () => {
      active = false;
    },
  };
}
