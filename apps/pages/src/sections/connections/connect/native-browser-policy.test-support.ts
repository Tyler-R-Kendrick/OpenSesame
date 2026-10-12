/** A previously verified sealed record, imported before the browser route audit. */
import {
  nativeApiFingerprint,
  nativeApiTarget,
} from "@opensesame/app-core/lib/native-api-target.js";
import { emptyNativePrivate } from "@opensesame/app-core/lib/native-connector-schema.js";
import { saveNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";

export async function savePriorApiProof(
  providerId: string,
  parameters: Record<string, string> = {},
) {
  const target = nativeApiTarget(providerId, parameters);
  const fingerprint = await nativeApiFingerprint(target);
  const privateState = emptyNativePrivate();
  privateState.credentials = Object.fromEntries(
    target.classification.privateCredentials.map((name) => [
      name,
      `private-prior-${name}`,
    ]),
  );
  privateState.verification = {
    fingerprint,
    verifiedAt: 100,
    kind: "provider",
  };
  privateState.grants.app = {
    providerId,
    actor: "app",
    kind: "api-key",
    fingerprint,
    accessToken: "private-prior-api_key",
    scopes: null,
    expiresAt: null,
  };
  return saveNativeConnector(
    {
      connectionId: `prior-${providerId}`,
      configuration: {
        version: 1,
        providerId,
        method: "api-key",
        displayName: `Saved ${target.providerName}`,
        icon: "",
        parameters: target.parameters,
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      privateState,
      runtime: {
        verifiedAt: 100,
        identity: null,
        targets: [],
        grants: [
          {
            actor: "app",
            label: "API key",
            permissionState: "provider-managed",
            grantedScopes: [],
            expiresAt: null,
            needsReauth: false,
          },
        ],
      },
    },
    target.classification,
  );
}
