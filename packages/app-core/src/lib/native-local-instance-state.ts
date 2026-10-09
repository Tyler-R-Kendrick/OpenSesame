/** Verified Vault/OpenBao facts become a bounded provider proof and sealed token binding. */
import type {
  NativeConfiguration,
  NativeRuntime,
} from "./native-connector-schema.js";
import { emptyNativePrivate } from "./native-connector-schema.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import type { NativeLocalInstanceFacts } from "./native-local-instance-http.js";
import type { NativeLocalInstanceInput } from "./native-local-instance.js";

function runtime(facts: NativeLocalInstanceFacts): NativeRuntime {
  return {
    verifiedAt: facts.verifiedAt,
    identity: facts.entityId
      ? {
          id: facts.entityId,
          label: facts.entityId,
          kind: "entity",
          assurance: "account-verified",
        }
      : null,
    targets: [],
    grants: [
      {
        actor: "user",
        label: `${facts.tokenLabel} (${facts.policies.length} provider policies)`,
        permissionState: "provider-managed",
        grantedScopes: [],
        expiresAt: facts.expiresAt,
        needsReauth: false,
      },
    ],
  };
}
export function nativeLocalInstanceGuard(record: NativeConnectorRecord) {
  return {
    revision: record.revision,
    fingerprint: record.configuration.fingerprint,
  };
}
export async function nativeLocalInstanceFingerprint(
  input: NativeLocalInstanceInput,
  endpoint: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      providerId: input.providerId,
      endpoint,
      namespace: input.namespace,
      credential: input.apiKey,
    }),
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function verifiedNativeLocalInstanceState(
  input: NativeLocalInstanceInput,
  endpoint: string,
  binding: string,
  facts: NativeLocalInstanceFacts,
): Pick<NativeConnectorRecord, "configuration" | "privateState" | "runtime"> {
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "api-key",
    displayName: input.displayName,
    icon: input.icon,
    parameters: { endpoint, namespace: input.namespace },
    requestedScopes: {},
    targetIds: {},
    fingerprint: binding,
  };
  const privateState = {
    ...emptyNativePrivate(),
    credentials: { api_key: input.apiKey },
    grants: {
      user: {
        providerId: input.providerId,
        actor: "user",
        fingerprint: binding,
        kind: "api-key" as const,
        accessToken: input.apiKey,
        expiresAt: facts.expiresAt,
        scopes: null,
        endpoint,
        targetId: facts.entityId ?? input.providerId,
      },
    },
    verification: {
      fingerprint: binding,
      verifiedAt: facts.verifiedAt,
      kind: "provider" as const,
    },
  };
  return { configuration, privateState, runtime: runtime(facts) };
}
