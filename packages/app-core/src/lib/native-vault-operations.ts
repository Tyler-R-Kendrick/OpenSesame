/** Vault operations use the authenticated session and preserve instance/namespace ownership. */
import { NativeApiError } from "./native-api-http.js";
import {
  assertNativeConnectorRevision,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { lookupNativeLocalInstance } from "./native-local-instance-http.js";
import {
  type NativeVaultKvData,
  type NativeVaultKvRead,
  readNativeVaultKv,
  vaultKvPath,
} from "./native-vault-kv.js";
export type {
  NativeVaultKvRead,
  NativeVaultKvData,
} from "./native-vault-kv.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  nativeVaultClassification,
  nativeVaultInput,
  requireNativeVault,
} from "./native-vault-session.js";

async function authorizeRead(
  connectionId: string,
  transport: NativeProviderTransport,
  verification = false,
) {
  const record = requireNativeVault(connectionId);
  await assertNativeConnectorRevision(connectionId, nativeOAuthGuard(record));
  const grant = record.privateState.grants.user;
  if (
    !grant ||
    grant.kind !== "oidc" ||
    record.privateState.recovery.length > 0 ||
    Object.keys(record.privateState.pending).length > 0 ||
    (!verification &&
      readNativeConnector(connectionId)?.status !== "connected") ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now())
  )
    throw new Error("Sign in to this instance again");
  transport.assertCurrent();
  return { record, grant, input: nativeVaultInput(connectionId) };
}
async function invalidateVault(
  connectionId: string,
  error: NativeApiError,
  expected: { revision: number; fingerprint: string },
) {
  if (![401, 403].includes(error.status)) return;
  await updateNativeConnector(
    connectionId,
    expected,
    nativeVaultClassification,
    (current) => {
      current.privateState.verification = null;
      current.runtime.verifiedAt = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
}
/** A read-only provider access check does not make the UI's saved revision stale. */
export async function checkNativeVaultAccess(
  connectionId: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const { record, grant, input } = await authorizeRead(connectionId, transport);
  try {
    const facts = await lookupNativeLocalInstance(
      input.endpoint,
      input.namespace,
      grant.accessToken,
      transport,
    );
    await assertNativeConnectorRevision(connectionId, nativeOAuthGuard(record));
    transport.assertCurrent();
    return facts;
  } catch (error) {
    if (error instanceof NativeApiError)
      await invalidateVault(connectionId, error, nativeOAuthGuard(record));
    throw error;
  }
}
export async function verifyNativeVault(
  connectionId: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const { record, grant, input } = await authorizeRead(
    connectionId,
    transport,
    true,
  );
  try {
    const facts = await lookupNativeLocalInstance(
      input.endpoint,
      input.namespace,
      grant.accessToken,
      transport,
    );
    return updateNativeConnector(
      connectionId,
      nativeOAuthGuard(record),
      nativeVaultClassification,
      (current) => {
        transport.assertCurrent();
        const verifiedAt = Math.max(
          facts.verifiedAt,
          (current.runtime.verifiedAt ?? 0) + 1,
        );
        current.privateState.verification = {
          fingerprint: current.configuration.fingerprint,
          verifiedAt,
          kind: "provider",
        };
        current.privateState.grants.user = {
          ...grant,
          expiresAt: facts.expiresAt,
        };
        current.runtime.verifiedAt = verifiedAt;
        current.runtime.identity = facts.entityId
          ? {
              id: facts.entityId,
              label: facts.tokenLabel,
              kind: "entity",
              assurance: "account-verified",
            }
          : null;
        current.runtime.grants = current.runtime.grants.map((metadata) => ({
          ...metadata,
          label: facts.tokenLabel,
          expiresAt: facts.expiresAt,
          needsReauth: false,
        }));
        return current;
      },
    );
  } catch (error) {
    if (error instanceof NativeApiError)
      await invalidateVault(connectionId, error, nativeOAuthGuard(record));
    throw error;
  }
}
/** Returns the provider's authorized KV v2 data; the caller decides where a secret may be displayed. */
export async function readNativeVaultInstance(
  connectionId: string,
  read: NativeVaultKvRead,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeVaultKvData> {
  vaultKvPath(read);
  const { record, grant, input } = await authorizeRead(connectionId, transport);
  try {
    const result = await readNativeVaultKv(
      input.endpoint,
      input.namespace,
      grant.accessToken,
      read,
      transport,
    );
    await assertNativeConnectorRevision(connectionId, nativeOAuthGuard(record));
    transport.assertCurrent();
    return result;
  } catch (error) {
    if (error instanceof NativeApiError && error.status === 401)
      await invalidateVault(connectionId, error, nativeOAuthGuard(record));
    throw error;
  }
}
