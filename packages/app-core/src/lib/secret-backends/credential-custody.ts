import { type CredentialItem, isRetired } from "@opensesame/vault-core";
import {
  discardVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
  stageVaultCredentials,
  vaultCredentialField,
} from "../vault-credential-custody.js";
import {
  encryptedRemoteContinuityError,
  preserveEncryptedRemoteContinuity,
} from "./encrypted-remote-codec.js";
import { SECRET_BACKEND_CREDENTIAL_FIELDS } from "./schema.js";
import type { SecretBackendDraft } from "./types.js";

export { initializeVaultCredentialCustody as initializeSecretBackendCustody };

/** Display names may change; credentials never move silently to another target. */
export function secretBackendCredentialTarget(
  draft: SecretBackendDraft,
): string {
  const target = [
    "secret-backend",
    draft.providerId,
    draft.mode,
    draft.baseUrl,
    draft.identityUrl,
    draft.vaultId,
    draft.projectId,
    draft.organizationId,
    draft.environment,
    draft.secretPath,
    draft.clientId,
    draft.passwordListId,
  ];
  // Keep legacy bindings byte-identical; explicit headers bind new authority.
  if (draft.appVersion) target.push("appVersion", draft.appVersion);
  if (
    draft.mode === "bitwarden-api" &&
    (draft.accountEmail || draft.deviceIdentifier)
  )
    target.push(draft.accountEmail ?? "", draft.deviceIdentifier ?? "");
  if (draft.remoteStoreId) target.push("remoteStoreId", draft.remoteStoreId);
  return JSON.stringify(target);
}
export function readSecretBackendCredentialItems(
  draft: SecretBackendDraft,
  tomb: string,
  reference: string,
) {
  return readVaultCredentials(
    reference,
    secretBackendCredentialTarget(draft),
    SECRET_BACKEND_CREDENTIAL_FIELDS,
    tomb,
  ).items;
}
export function readSecretBackendCredentials(
  draft: SecretBackendDraft,
  tomb: string,
  reference: string,
): SecretBackendDraft {
  const { fields } = readVaultCredentials(
    reference,
    secretBackendCredentialTarget(draft),
    SECRET_BACKEND_CREDENTIAL_FIELDS,
    tomb,
  );
  return {
    ...draft,
    token: fields.get("token") ?? "",
    clientSecret: fields.get("clientSecret") ?? "",
    encryptionKey: fields.get("encryptionKey") ?? "",
  };
}
export async function stageSecretBackendCredentials(
  draft: SecretBackendDraft,
  tomb: string,
  check: () => void,
  previous: readonly CredentialItem[] = [],
) {
  const continuity = await continuityForStaging(draft, tomb, check, previous);
  const staged = await stageVaultCredentials(
    {
      name: draft.name,
      targetBinding: secretBackendCredentialTarget(draft),
      fields: SECRET_BACKEND_CREDENTIAL_FIELDS.map((field) => ({
        field,
        label: {
          token: "Access token",
          clientSecret: "Client secret",
          encryptionKey: "Encryption key",
        }[field],
        value: draft[field] ?? "",
        metadata: field === "encryptionKey" ? continuity.fields : undefined,
      })),
    },
    tomb,
    check,
  );
  return { ...staged, checkContinuity: continuity.check };
}
async function continuityForStaging(
  draft: SecretBackendDraft,
  tomb: string,
  check: () => void,
  previous: readonly CredentialItem[],
) {
  if (!draft.encryptionKey || !draft.remoteStoreId)
    return { fields: [], check: () => {} };
  check();
  const { vaultStore } = await import("../vault/store.js");
  check();
  const identity = {
    objectUrl: new URL(draft.baseUrl).href,
    storeId: draft.remoteStoreId,
  };
  const oldIds = new Set(
    previous
      .filter((item) => vaultCredentialField(item) === "encryptionKey")
      .map((item) => item.id),
  );
  const candidates = () => {
    check();
    const state = vaultStore.getSnapshot();
    if (state.tomb !== tomb || state.guest || state.status !== "unlocked")
      throw encryptedRemoteContinuityError();
    const keys = state.items.filter(
      (item): item is CredentialItem =>
        item.kind === "credential" &&
        item.accountId === null &&
        item.deletedAt === null &&
        !isRetired(item) &&
        vaultCredentialField(item) === "encryptionKey" &&
        (oldIds.has(item.id) ||
          (item.method.type === "token" &&
            item.method.token === draft.encryptionKey)),
    );
    if ([...oldIds].some((id) => !keys.some((item) => item.id === id)))
      throw encryptedRemoteContinuityError();
    return keys;
  };
  const held = preserveEncryptedRemoteContinuity(identity, candidates());
  return {
    fields: [held],
    check: () => {
      if (
        preserveEncryptedRemoteContinuity(identity, candidates()).value !==
        held.value
      )
        throw encryptedRemoteContinuityError();
    },
  };
}
export function discardSecretBackendCredentials(
  items: readonly CredentialItem[],
  tomb: string,
  check: () => void,
) {
  return discardVaultCredentials({ items }, tomb, check);
}
