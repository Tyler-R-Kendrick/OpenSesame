/** The saved state every key-driven connection shares: what verified it, and what forgetting it means. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
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
import type {
  NativeKeyProof,
  NativeKeySpec,
  NativeKeyTarget,
} from "./native-key-types.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

type Classification = NativeKeySpec<NativeKeyTarget>["classification"];

/** Ties a verified connection to the exact key it was verified with. */
export function nativeKeyBinding(
  classification: Classification,
  credentials: Record<string, string>,
): string {
  const packed = JSON.stringify(
    classification.privateCredentials.map((key) => credentials[key] ?? ""),
  );
  return bytesToHex(sha256(new TextEncoder().encode(packed)));
}

/** The saved connection, only if it is this family's and (when asked) still the one that was verified. */
export function requireNativeKey(
  spec: Pick<
    NativeKeySpec<NativeKeyTarget>,
    "family" | "accepts" | "classification"
  >,
  id: string,
  authorized = false,
): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    !spec.accepts(record.configuration.providerId) ||
    record.configuration.method !== "api-key"
  )
    throw new Error(`Saved ${spec.family} browser connection not found`);
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
        nativeKeyBinding(spec.classification, record.privateState.credentials))
  )
    throw new Error(`Verify ${spec.family} access before use`);
  return record;
}

/** A connection that has just been proved, with the proof recorded and the key bound to it. */
export function verifiedNativeKey(
  classification: Classification,
  id: string,
  revision: number,
  configuration: NativeConfiguration,
  credentials: Record<string, string>,
  proof: NativeKeyProof,
  previousVerifiedAt = 0,
): NativeConnectorRecord {
  const verifiedAt = Math.max(Date.now(), previousVerifiedAt + 1);
  const privateState = emptyNativePrivate();
  privateState.credentials = credentials;
  privateState.grants.app = {
    kind: "api-key",
    providerId: configuration.providerId,
    actor: "app",
    fingerprint: configuration.fingerprint,
    targetId: proof.target.id,
    accessToken: nativeKeyBinding(classification, credentials),
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
      identity: { ...proof.identity, assurance: "credential-valid" },
      targets: [...proof.targets],
      grants: [
        {
          actor: "app",
          label: proof.grantLabel,
          permissionState: "provider-managed",
          grantedScopes: [],
          expiresAt: null,
          needsReauth: false,
        },
      ],
    },
  };
}

/** The key was refused: the connection stops looking verified, and keeps everything else. */
export function invalidateNativeKey(
  classification: Classification,
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  return updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    classification,
    (current) => {
      transport.assertCurrent();
      current.privateState.verification = null;
      return current;
    },
    () => transport.assertCurrent(),
  );
}

/** A static key has nothing to revoke from here: forgetting it locally is all this can do. */
export function nativeKeyCleanup(
  spec: Pick<
    NativeKeySpec<NativeKeyTarget>,
    "family" | "accepts" | "classification"
  >,
): NativeProviderCleanup {
  const ours = (configuration: NativeConfiguration) =>
    spec.accepts(configuration.providerId) &&
    configuration.method === "api-key";
  return {
    credentialSlots: spec.classification.privateCredentials,
    classification: (configuration) => {
      if (!ours(configuration))
        throw new Error(
          `${spec.family} cleanup belongs to its saved browser connection`,
        );
      return spec.classification;
    },
    cleanup: async (obligation, context) => {
      const grant = obligation.grant;
      if (
        !ours(context.configuration) ||
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
          `${spec.family} cleanup changed; reload the saved browser connection`,
        );
      return "local-credential-forgotten";
    },
  };
}
