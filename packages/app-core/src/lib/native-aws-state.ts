import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { assertNativeApiEditable } from "./native-api-authority.js";
import {
  NATIVE_AWS_SERVICES,
  isNativeAwsProvider,
  nativeAwsClassification,
  nativeAwsProviderOf,
} from "./native-aws-input.js";
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
import { nativeConnectorView } from "./native-connector-view.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

/** Ties a verified connection to the exact key it was verified with. */
export function nativeAwsCredentialBinding(
  credentials: Record<string, string>,
) {
  const packed = JSON.stringify([
    credentials.secret_access_key ?? "",
    credentials.session_token ?? "",
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(packed)));
}

export function requireNativeAws(id: string, authorized = false) {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    !isNativeAwsProvider(record.configuration.providerId) ||
    record.configuration.method !== "api-key"
  )
    throw new Error("Saved AWS browser connection not found");
  assertNativeApiEditable(record);
  if (
    authorized &&
    (nativeConnectorView(
      id,
      record.revision,
      record.configuration,
      record.runtime,
      record.privateState,
    ).status !== "connected" ||
      record.privateState.grants.app?.accessToken !==
        nativeAwsCredentialBinding(record.privateState.credentials))
  )
    throw new Error("Verify AWS access before use");
  return record;
}

export function verifiedNativeAws(
  id: string,
  revision: number,
  configuration: NativeConfiguration,
  credentials: Record<string, string>,
  previousVerifiedAt = 0,
): NativeConnectorRecord {
  const providerId = nativeAwsProviderOf(configuration.providerId);
  const verifiedAt = Math.max(Date.now(), previousVerifiedAt + 1);
  const region = configuration.parameters.region ?? "";
  const privateState = emptyNativePrivate();
  privateState.credentials = credentials;
  privateState.grants.app = {
    kind: "api-key",
    providerId,
    actor: "app",
    fingerprint: configuration.fingerprint,
    targetId: region,
    accessToken: nativeAwsCredentialBinding(credentials),
    expiresAt: null,
    scopes: null,
  };
  privateState.verification = {
    fingerprint: configuration.fingerprint,
    verifiedAt,
    kind: "provider",
  };
  return {
    connectionId: id,
    revision,
    configuration,
    privateState,
    runtime: {
      verifiedAt,
      identity: {
        id: region,
        label: `${NATIVE_AWS_SERVICES[providerId].name} in ${region}`,
        kind: "region",
        assurance: "credential-valid",
      },
      targets: [{ id: region, label: region, kind: "region" }],
      grants: [
        {
          actor: "app",
          label: "AWS signing credentials",
          permissionState: "provider-managed",
          grantedScopes: [],
          expiresAt: null,
          needsReauth: false,
        },
      ],
    },
  };
}

export async function invalidateNativeAws(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  return updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    nativeAwsClassification,
    (current) => {
      transport.assertCurrent();
      current.privateState.verification = null;
      return current;
    },
    () => transport.assertCurrent(),
  );
}

/** A static access key has nothing to revoke from here: forgetting it locally is all this can do. */
export const nativeAwsCleanup: NativeProviderCleanup = {
  credentialSlots: ["secret_access_key", "session_token"],
  classification: (configuration) => {
    if (
      !isNativeAwsProvider(configuration.providerId) ||
      configuration.method !== "api-key"
    )
      throw new Error("AWS cleanup belongs to its saved browser connection");
    return nativeAwsClassification;
  },
  cleanup: async (obligation, context) => {
    const grant = obligation.grant;
    if (
      !isNativeAwsProvider(context.configuration.providerId) ||
      context.configuration.method !== "api-key" ||
      obligation.providerId !== context.configuration.providerId ||
      obligation.kind !== "revoke" ||
      obligation.fingerprint !== context.configuration.fingerprint ||
      !grant ||
      grant.kind !== "api-key" ||
      grant.actor !== obligation.actor ||
      grant.providerId !== obligation.providerId ||
      grant.fingerprint !== obligation.fingerprint ||
      grant.targetId !== obligation.targetId
    )
      throw new Error(
        "AWS cleanup changed; reload the saved browser connection",
      );
    return "local-credential-forgotten";
  },
};
