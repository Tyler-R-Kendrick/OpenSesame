import type { CredentialItem } from "@opensesame/vault-core";
import {
  discardVaultCredentials,
  initializeVaultCredentialCustody,
  readVaultCredentials,
  stageVaultCredentials,
} from "../vault-credential-custody.js";
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
export function stageSecretBackendCredentials(
  draft: SecretBackendDraft,
  tomb: string,
  check: () => void,
) {
  return stageVaultCredentials(
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
      })),
    },
    tomb,
    check,
  );
}
export function discardSecretBackendCredentials(
  items: readonly CredentialItem[],
  tomb: string,
  check: () => void,
) {
  return discardVaultCredentials({ items }, tomb, check);
}
