import type {
  NativeCleanupContext,
  NativeCleanupOutcome,
} from "./native-connector-lifecycle.js";
import type {
  NativeFieldClassification,
  NativeRecovery,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeOAuthClientOwner } from "./native-oauth-client-config.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  assertVaultCredentials,
  discardVaultCredentials,
  readVaultCredentialsForWithdrawal,
} from "./vault-credential-custody.js";

export const ORIGIN_PROVIDER_ID = "origin";

export function supersededNativeOriginRecovery(
  old: NativeConnectorRecord,
): NativeRecovery {
  return {
    id: `origin-key-cleanup:${old.revision}`,
    kind: "revoke",
    providerId: ORIGIN_PROVIDER_ID,
    actor: "user",
    fingerprint: old.configuration.fingerprint,
    targetId: old.configuration.clientId ?? ORIGIN_PROVIDER_ID,
    credentials: {
      phase: "superseded",
      origin_app_reference:
        old.privateState.credentials.origin_app_reference ?? "",
      origin_app_vault: old.privateState.credentials.origin_app_vault ?? "",
      origin_app_binding: old.configuration.fingerprint,
    },
  };
}

export async function prepareNativeOriginKeyCleanup(
  id: string,
  owner: NativeOAuthClientOwner,
  classification: NativeFieldClassification,
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  if (
    Object.keys(record.privateState.grants).length ||
    Object.keys(record.privateState.pending).length ||
    record.privateState.recovery.length
  )
    return;
  const reference = record.privateState.credentials.origin_app_reference;
  if (!reference) return;
  const held = readVaultCredentialsForWithdrawal(
    reference,
    record.configuration.fingerprint,
    ["appPrivateKey"],
    owner.tomb,
  );
  if (!held) return;
  const check = () =>
    assertVaultCredentials(held, owner.tomb, () =>
      owner.transport.assertCurrent(),
    );
  const { revision } = record;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    classification,
    (current) => {
      check();
      current.privateState.recovery.push({
        id: `origin-key-cleanup:${revision}`,
        kind: "revoke",
        providerId: ORIGIN_PROVIDER_ID,
        actor: "user",
        fingerprint: current.configuration.fingerprint,
        targetId: current.configuration.clientId ?? ORIGIN_PROVIDER_ID,
        credentials: {
          origin_app_reference:
            current.privateState.credentials.origin_app_reference ?? "",
          origin_app_vault:
            current.privateState.credentials.origin_app_vault ?? "",
        },
      });
      return current;
    },
    check,
  );
}

function activeOriginBinding(
  record: NativeConnectorRecord,
  reference: string,
  binding: string | undefined,
): boolean {
  return (
    binding === undefined &&
    record.privateState.credentials.origin_app_reference === reference
  );
}

function supersededOriginBinding(
  record: NativeConnectorRecord,
  reference: string,
  binding: string | undefined,
): boolean {
  if (!binding) return false;
  return (
    record.privateState.credentials.origin_app_reference !== reference ||
    record.configuration.fingerprint !== binding
  );
}

function originCleanupBinding(
  record: NativeConnectorRecord,
  reference: string,
  credentials: NativeRecovery["credentials"],
  tomb: string,
): boolean {
  if (credentials?.origin_app_vault !== tomb) return false;
  return credentials.phase === "superseded"
    ? supersededOriginBinding(record, reference, credentials.origin_app_binding)
    : activeOriginBinding(record, reference, credentials.origin_app_binding);
}

export async function discardNativeOriginKey(
  obligation: NativeRecovery,
  context: Pick<NativeCleanupContext, "configuration" | "connectionId">,
  owner: NativeOAuthClientOwner,
  check: () => void,
): Promise<NativeCleanupOutcome> {
  if (!obligation.grant && obligation.credentials?.phase === "exchange")
    throw new NativeOAuthError("cleanup");
  const reference = obligation.credentials?.origin_app_reference;
  if (reference) {
    check();
    const record = requireNativeOAuthRecord(context.connectionId);
    if (
      !originCleanupBinding(
        record,
        reference,
        obligation.credentials,
        owner.tomb,
      )
    )
      throw new NativeOAuthError("expired");
    const held = readVaultCredentialsForWithdrawal(
      reference,
      obligation.credentials?.origin_app_binding ??
        context.configuration.fingerprint,
      ["appPrivateKey"],
      owner.tomb,
    );
    if (held)
      await discardVaultCredentials(held, owner.tomb, () =>
        owner.transport.assertCurrent(),
      );
  }
  return "local-credential-forgotten";
}
