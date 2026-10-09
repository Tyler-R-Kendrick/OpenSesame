/** KV reads require the exact verified token, instance and namespace; an ACL denial is not invalid authentication. */
import { NativeApiError } from "./native-api-http.js";
import {
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeLocalInstanceFingerprint } from "./native-local-instance-state.js";
import { readNativeLocalInstance } from "./native-local-instance.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  type NativeVaultKvData,
  type NativeVaultKvRead,
  readNativeVaultKv,
  vaultKvPath,
} from "./native-vault-kv.js";

const classification = {
  publicParameters: ["endpoint", "namespace"],
  privateCredentials: ["api_key"],
};
function requireVerifiedToken(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    !["vault", "openbao"].includes(record.configuration.providerId) ||
    record.configuration.method !== "api-key"
  )
    throw new Error("Saved Vault or OpenBao token connection not found");
  const grant = record.privateState.grants.user;
  const token = record.privateState.credentials.api_key;
  if (
    readNativeConnector(id)?.status !== "connected" ||
    !grant ||
    grant.kind !== "api-key" ||
    !token ||
    grant.accessToken !== token ||
    grant.fingerprint !== record.configuration.fingerprint ||
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new Error("Verify this provider token before reading a secret");
  return { record, token, grant };
}
async function authorizeTokenRead(
  id: string,
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  const { record, token, grant } = requireVerifiedToken(id);
  const endpoint = record.configuration.parameters.endpoint ?? "";
  const namespace = record.configuration.parameters.namespace ?? "";
  const fingerprint = await nativeLocalInstanceFingerprint(
    {
      providerId:
        record.configuration.providerId === "vault" ? "vault" : "openbao",
      displayName: record.configuration.displayName,
      icon: record.configuration.icon,
      endpoint,
      namespace,
      apiKey: token,
    },
    endpoint,
  );
  if (
    fingerprint !== record.configuration.fingerprint ||
    grant.endpoint !== endpoint
  )
    throw new Error(
      "Provider token does not match this instance and namespace",
    );
  await assertNativeConnectorRevision(id, nativeOAuthGuard(record));
  await readNativeLocalInstance(id, transport);
  return { record, token, endpoint, namespace };
}
export async function readNativeVaultToken(
  id: string,
  read: NativeVaultKvRead,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeVaultKvData> {
  vaultKvPath(read);
  const { record, token, endpoint, namespace } = await authorizeTokenRead(
    id,
    transport,
  );
  try {
    const result = await readNativeVaultKv(
      endpoint,
      namespace,
      token,
      read,
      transport,
    );
    await assertNativeConnectorRevision(id, nativeOAuthGuard(record));
    transport.assertCurrent();
    return result;
  } catch (error) {
    if (error instanceof NativeApiError && error.status === 401)
      await updateNativeConnector(
        id,
        nativeOAuthGuard(record),
        classification,
        (current) => {
          transport.assertCurrent();
          current.privateState.verification = null;
          current.runtime.verifiedAt = null;
          current.runtime.grants = current.runtime.grants.map((grant) => ({
            ...grant,
            needsReauth: true,
          }));
          return current;
        },
      );
    throw error;
  }
}
