import type { Connection } from "../connections.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  removeDeviceConfigurationDurable,
} from "../device-connector-records.js";
import { deviceConnectorView } from "../device-connector-view.js";
import { saveDeviceConnectorConfigurationDurable } from "../device-connectors.js";
import { kvHydrate } from "../kv.js";
import { assertVaultCredentials } from "../vault-credential-custody.js";
import {
  discardSecretBackendCredentials,
  initializeSecretBackendCustody,
  readSecretBackendCredentialItems,
  readSecretBackendCredentials,
  secretBackendCredentialTarget,
  stageSecretBackendCredentials,
} from "./credential-custody.js";
import {
  SECRET_BACKEND_CREDENTIAL_FIELDS,
  publicSecretBackendDraft,
  validateSecretBackendDraft,
} from "./schema.js";
import { type SecretBackendDraft, SecretBackendError } from "./types.js";

const FIELD = "secret_backend_configuration";
const CREDENTIALS = "secret_backend_credentials";

export async function hydrateSecretBackendConnections(): Promise<void> {
  await initializeSecretBackendCustody();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}

/** Settings and catalog views never receive stored tokens. */
export function readSecretBackendConnection(
  connectionId: string,
): SecretBackendDraft | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  const raw = row?.fields[FIELD];
  if (!raw) return null;
  try {
    const draft = publicSecretBackendDraft(JSON.parse(raw));
    return draft.providerId === row?.providerId ? draft : null;
  } catch {
    return null;
  }
}

export function listSecretBackendConnections(): Connection[] {
  return readDeviceRows()
    .filter((row) => readSecretBackendConnection(row.connectionId))
    .map(deviceConnectorView);
}

/** Public scope binding is checked before any sealed credential is opened. */
export function secretBackendConnectionVault(
  connectionId: string,
): string | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  return readSecretBackendConnection(connectionId)
    ? row?.fields.secret_backend_vault || null
    : null;
}

/** Runtime-only: a credential may be used solely at its saved target. */
export function secretBackendRuntimeConfiguration(
  connectionId: string,
  vaultTomb: string,
): SecretBackendDraft | null {
  const draft = readSecretBackendConnection(connectionId);
  if (!draft || secretBackendConnectionVault(connectionId) !== vaultTomb)
    return null;
  try {
    const row = readDeviceRows().find(
      (entry) => entry.connectionId === connectionId,
    );
    return validateSecretBackendDraft(
      readSecretBackendCredentials(
        draft,
        vaultTomb,
        row?.fields[CREDENTIALS] ?? "",
      ),
    );
  } catch {
    return null;
  }
}

function sameCredentialTarget(
  a: SecretBackendDraft,
  b: SecretBackendDraft,
): boolean {
  return secretBackendCredentialTarget(a) === secretBackendCredentialTarget(b);
}

export function resolveSecretBackendConfiguration(
  value: SecretBackendDraft,
  existingId?: string,
  vaultTomb?: string,
): SecretBackendDraft {
  const draft = validateSecretBackendDraft(value, false);
  if (!existingId) return validateSecretBackendDraft(draft);
  const previous = secretBackendRuntimeConfiguration(
    existingId,
    vaultTomb ?? "",
  );
  const publicPrevious = readSecretBackendConnection(existingId);
  if (
    !publicPrevious ||
    publicPrevious.providerId !== draft.providerId ||
    secretBackendConnectionVault(existingId) !== vaultTomb
  )
    throw new SecretBackendError(
      "configuration",
      "This saved secret backend does not match the provider.",
    );
  if (previous && sameCredentialTarget(previous, draft)) {
    for (const field of SECRET_BACKEND_CREDENTIAL_FIELDS)
      if (!draft[field]) draft[field] = previous[field] ?? "";
  }
  return validateSecretBackendDraft(draft);
}

function cleanupItems(
  draft: SecretBackendDraft | null,
  tomb: string,
  reference: string,
) {
  try {
    return draft
      ? readSecretBackendCredentialItems(draft, tomb, reference)
      : [];
  } catch {
    // A broken reference cannot authorize deleting an unrelated vault item.
    return [];
  }
}

export async function writeSecretBackendConnection(
  draft: SecretBackendDraft,
  vaultTomb: string,
  existingId?: string,
  beforeCommit: () => void = () => {},
  cleanupCheck: () => void = beforeCommit,
): Promise<Connection> {
  const resolved = resolveSecretBackendConfiguration(
    draft,
    existingId,
    vaultTomb,
  );
  const previous = existingId
    ? readDeviceRows().find((row) => row.connectionId === existingId)
    : undefined;
  const previousDraft = existingId
    ? readSecretBackendConnection(existingId)
    : null;
  const oldItems = cleanupItems(
    previousDraft,
    vaultTomb,
    previous?.fields[CREDENTIALS] ?? "",
  );
  const staged = await stageSecretBackendCredentials(
    resolved,
    vaultTomb,
    beforeCommit,
  );
  const publicationCheck = () =>
    assertVaultCredentials(staged, vaultTomb, beforeCommit);
  let saved: Connection;
  try {
    saved = await saveDeviceConnectorConfigurationDurable(
      () => {
        publicationCheck();
        return {
          providerId: resolved.providerId,
          displayName: resolved.name,
          scopes: [],
          fields: {
            [FIELD]: JSON.stringify(publicSecretBackendDraft(resolved)),
            self_hosted_configuration: "secret-backend-v1",
            secret_backend_vault: vaultTomb,
            [CREDENTIALS]: staged.reference,
          },
          secrets: {},
        };
      },
      existingId,
      publicationCheck,
    );
  } catch (error) {
    await discardSecretBackendCredentials(
      staged.items,
      vaultTomb,
      cleanupCheck,
    ).catch(() => undefined);
    throw error;
  }
  await discardSecretBackendCredentials(
    oldItems,
    vaultTomb,
    cleanupCheck,
  ).catch(() => undefined);
  return saved;
}

export async function removeSecretBackendConnection(
  connectionId: string,
  vaultTomb: string,
  beforeCommit: () => void = () => {},
  cleanupCheck: () => void = beforeCommit,
): Promise<boolean> {
  const draft = readSecretBackendConnection(connectionId);
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  const items = cleanupItems(draft, vaultTomb, row?.fields[CREDENTIALS] ?? "");
  const removed = await removeDeviceConfigurationDurable(
    connectionId,
    () => {
      beforeCommit?.();
      if (
        !readSecretBackendConnection(connectionId) ||
        secretBackendConnectionVault(connectionId) !== vaultTomb
      )
        throw new SecretBackendError(
          "configuration",
          "Saved secret backend not found.",
        );
    },
    beforeCommit,
  );
  if (removed)
    await discardSecretBackendCredentials(items, vaultTomb, cleanupCheck).catch(
      () => undefined,
    );
  return removed;
}
