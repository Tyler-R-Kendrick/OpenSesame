/** Personal tokens stay sealed; provider-managed permissions are never invented. */
import {
  assertNativeApiAuthority,
  assertNativeApiEditable,
} from "./native-api-authority.js";
import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";
import {
  type NativeConfiguration,
  emptyNativePrivate,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeGithubOrigin } from "./native-github-personal-http.js";

export const nativeGithubPersonalClassification = {
  publicParameters: [],
  privateCredentials: ["api_key"],
};
export function requireNativeGithubPersonal(id: string, authorized = false) {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    record.configuration.providerId !== "github" ||
    record.configuration.method !== "api-key"
  )
    throw new Error("Saved GitHub personal-token connection not found");
  assertNativeApiEditable(record);
  if (authorized) assertNativeApiAuthority(record);
  return record;
}
export async function nativeGithubPersonalFingerprint(): Promise<string> {
  const input = new TextEncoder().encode(
    "github:personal-token:v1:https://api.github.com:user:user/repos:2022-11-28",
  );
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", input))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function verifiedNativeGithubPersonal(
  connectionId: string,
  revision: number,
  configuration: NativeConfiguration,
  token: string,
  identity: { id: string; label: string },
  previousVerifiedAt = 0,
): NativeConnectorRecord {
  const verifiedAt = Math.max(Date.now(), previousVerifiedAt + 1);
  const privateState = emptyNativePrivate();
  privateState.credentials = { api_key: token };
  privateState.grants.app = {
    kind: "api-key",
    providerId: "github",
    actor: "app",
    fingerprint: configuration.fingerprint,
    targetId: identity.id,
    accessToken: token,
    expiresAt: null,
    scopes: null,
  };
  privateState.verification = {
    fingerprint: configuration.fingerprint,
    verifiedAt,
    kind: "provider",
  };
  return {
    connectionId,
    revision,
    configuration,
    privateState,
    runtime: {
      verifiedAt,
      identity: { ...identity, kind: "user", assurance: "account-verified" },
      targets: [{ id: nativeGithubOrigin, label: "GitHub API", kind: "api" }],
      grants: [
        {
          actor: "app",
          label: "Personal access token",
          permissionState: "provider-managed",
          grantedScopes: [],
          expiresAt: null,
          needsReauth: false,
        },
      ],
    },
  };
}
export async function invalidateNativeGithubPersonal(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  return updateNativeConnector(
    record.connectionId,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    nativeGithubPersonalClassification,
    (current) => {
      transport.assertCurrent();
      current.privateState.verification = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
}
export const nativeGithubPersonalCleanup: NativeProviderCleanup = {
  classification: (configuration) => {
    if (
      configuration.providerId !== "github" ||
      configuration.method !== "api-key"
    )
      throw new Error(
        "GitHub personal-token cleanup belongs to its saved connection",
      );
    return nativeGithubPersonalClassification;
  },
  cleanup: async (obligation, context) => {
    const grant = obligation.grant;
    if (
      context.configuration.providerId !== "github" ||
      context.configuration.method !== "api-key" ||
      obligation.providerId !== "github" ||
      obligation.fingerprint !== context.configuration.fingerprint ||
      obligation.kind !== "revoke" ||
      !grant ||
      grant.kind !== "api-key" ||
      grant.providerId !== obligation.providerId ||
      grant.actor !== obligation.actor ||
      grant.fingerprint !== obligation.fingerprint ||
      grant.targetId !== obligation.targetId
    )
      throw new Error(
        "GitHub personal-token cleanup changed; reload the saved connection",
      );
    return "local-credential-forgotten";
  },
};
