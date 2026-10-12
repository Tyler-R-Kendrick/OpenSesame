import { assertNativeApiEditable } from "./native-api-authority.js";
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
import { nativeS3Classification } from "./native-s3-input.js";

export function nativeS3CredentialBinding(credentials: Record<string, string>) {
  const packed = JSON.stringify([
    credentials.secret_access_key ?? "",
    credentials.session_token ?? "",
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(packed)));
}

export function requireNativeS3(id: string, authorized = false) {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    record.configuration.providerId !== "s3" ||
    record.configuration.method !== "api-key"
  )
    throw new Error("Saved S3 browser connection not found");
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
        nativeS3CredentialBinding(record.privateState.credentials))
  )
    throw new Error("Verify S3 bucket permission before use");
  return record;
}
export function verifiedNativeS3(
  id: string,
  revision: number,
  configuration: NativeConfiguration,
  credentials: Record<string, string>,
  previousVerifiedAt = 0,
): NativeConnectorRecord {
  const verifiedAt = Math.max(Date.now(), previousVerifiedAt + 1);
  const bucket = configuration.parameters.bucket ?? "";
  const privateState = emptyNativePrivate();
  privateState.credentials = credentials;
  privateState.grants.app = {
    kind: "api-key",
    providerId: "s3",
    actor: "app",
    fingerprint: configuration.fingerprint,
    targetId: bucket,
    accessToken: nativeS3CredentialBinding(credentials),
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
        id: bucket,
        label: bucket,
        kind: "bucket",
        assurance: "credential-valid",
      },
      targets: [{ id: bucket, label: bucket, kind: "bucket" }],
      grants: [
        {
          actor: "app",
          label: "S3 signing credentials",
          permissionState: "provider-managed",
          grantedScopes: [],
          expiresAt: null,
          needsReauth: false,
        },
      ],
    },
  };
}
export async function invalidateNativeS3(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  return updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    nativeS3Classification,
    (current) => {
      transport.assertCurrent();
      current.privateState.verification = null;
      return current;
    },
    () => transport.assertCurrent(),
  );
}
export const nativeS3Cleanup: NativeProviderCleanup = {
  credentialSlots: ["secret_access_key", "session_token"],
  classification: (configuration) => {
    if (configuration.providerId !== "s3" || configuration.method !== "api-key")
      throw new Error("S3 cleanup belongs to its saved browser connection");
    return nativeS3Classification;
  },
  cleanup: async (obligation, context) => {
    const grant = obligation.grant;
    if (
      context.configuration.providerId !== "s3" ||
      context.configuration.method !== "api-key" ||
      obligation.providerId !== "s3" ||
      obligation.kind !== "revoke" ||
      obligation.fingerprint !== context.configuration.fingerprint ||
      !grant ||
      grant.kind !== "api-key" ||
      grant.actor !== obligation.actor ||
      grant.providerId !== "s3" ||
      grant.fingerprint !== obligation.fingerprint ||
      grant.targetId !== obligation.targetId
    )
      throw new Error(
        "S3 cleanup changed; reload the saved browser connection",
      );
    return "local-credential-forgotten";
  },
};
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
