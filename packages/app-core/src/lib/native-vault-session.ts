import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
/** Sealed, single-use Vault OIDC requests belong to one connector and browser authorization. */
import type { NativeFieldClassification } from "./native-connector-schema.js";
import {
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  readNativeConnector,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  type NativeVaultAppearance,
  nativeVaultAppearance,
  updateNativeVaultAppearance,
} from "./native-vault-appearance.js";
import {
  type NativeVaultOidcInput,
  vaultAuthorizationUrl,
  vaultOidcInput,
  vaultOidcRandom,
} from "./native-vault-http.js";

export const nativeVaultClassification: NativeFieldClassification = {
  publicParameters: [
    "endpoint",
    "namespace",
    "auth_mount",
    "role",
    "authorization_outcome",
  ],
  privateCredentials: ["api_key", "oidc_nonce"],
};
export function requireNativeVault(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    !["vault", "openbao"].includes(record.configuration.providerId) ||
    record.configuration.method !== "oidc"
  )
    throw new Error("Saved Vault OIDC connection not found");
  return record;
}
export function nativeVaultInput(id: string): NativeVaultOidcInput {
  const record = requireNativeVault(id);
  const parameters = record.configuration.parameters;
  return vaultOidcInput({
    providerId:
      record.configuration.providerId === "vault" ? "vault" : "openbao",
    endpoint: parameters.endpoint ?? "",
    namespace: parameters.namespace ?? "",
    authMount: parameters.auth_mount ?? "oidc",
    role: parameters.role ?? "",
  });
}
export async function configureNativeVault(
  input: NativeVaultOidcInput & NativeVaultAppearance,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  const request = vaultOidcInput(input);
  const parameters = {
    endpoint: request.endpoint,
    namespace: request.namespace,
    auth_mount: request.authMount,
    role: request.role,
  };
  if (input.connectionId) {
    const existing = requireNativeVault(input.connectionId);
    if (
      existing.configuration.providerId !== input.providerId ||
      (input.revision !== undefined && existing.revision !== input.revision)
    )
      throw new Error("Connector changed; reload before signing in");
    await assertNativeConnectorRevision(
      existing.connectionId,
      nativeOAuthGuard(existing),
    );
    if (
      JSON.stringify(
        Object.fromEntries(
          Object.entries(existing.configuration.parameters).filter(
            ([key]) => key !== "authorization_outcome",
          ),
        ),
      ) === JSON.stringify(parameters)
    )
      return updateNativeVaultAppearance(
        existing,
        input,
        transport,
        nativeVaultClassification,
      );
    throw new Error(
      "Disconnect this instance before changing its authorization binding",
    );
  }
  const fingerprint = vaultOidcRandom();
  const connectionId = `conn_vault_${crypto.randomUUID()}`;
  const appearance = nativeVaultAppearance(input, {
    displayName: input.providerId === "vault" ? "HashiCorp Vault" : "OpenBao",
    icon: "",
  });
  await saveNativeConnector(
    {
      connectionId,
      configuration: {
        version: 1,
        providerId: input.providerId,
        method: "oidc",
        ...appearance,
        parameters,
        requestedScopes: {},
        targetIds: {},
        fingerprint,
      },
      privateState: emptyNativePrivate(),
      runtime: emptyNativeRuntime(),
    },
    nativeVaultClassification,
    () => transport.assertCurrent(),
  );
  return connectionId;
}
export async function authorizeNativeVault(
  connectionId: string,
  redirectUri: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const authTransport = captureNativeAuthorizationTransport(transport);
  authTransport.assertCurrent();
  const record = requireNativeVault(connectionId);
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new Error("Finish or cancel the pending authorization first");
  await assertNativeConnectorRevision(connectionId, nativeOAuthGuard(record));
  const clientNonce = vaultOidcRandom();
  const authorization = await vaultAuthorizationUrl(
    nativeVaultInput(connectionId),
    redirectUri,
    clientNonce,
    authTransport,
  );
  const createdAt = Date.now();
  const expiresAt = createdAt + 5 * 60_000;
  await updateNativeConnector(
    connectionId,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      authTransport.assertCurrent();
      current.privateState.credentials.oidc_nonce = authorization.nonce;
      current.privateState.pending.user = {
        providerId: current.configuration.providerId,
        actor: "user",
        fingerprint: current.configuration.fingerprint,
        state: authorization.state,
        verifier: clientNonce,
        redirectUri,
        createdAt,
        expiresAt,
        scopes: [],
        endpoint: current.configuration.parameters.endpoint,
      };
      return current;
    },
  );
  return {
    connectionId,
    authorizationUrl: authorization.authorizationUrl,
    state: authorization.state,
    expiresAt,
  };
}
export async function cancelNativeVaultOidc(
  connectionId: string,
  expectedState?: string,
) {
  const record = requireNativeVault(connectionId);
  if (
    expectedState &&
    record.privateState.pending.user?.state !== expectedState
  )
    return readNativeConnector(connectionId);
  return updateNativeConnector(
    connectionId,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      current.privateState.pending = Object.fromEntries(
        Object.entries(current.privateState.pending).filter(
          ([actor]) => actor !== "user",
        ),
      );
      current.privateState.credentials = Object.fromEntries(
        Object.entries(current.privateState.credentials).filter(
          ([name]) => name !== "oidc_nonce",
        ),
      );
      return current;
    },
  );
}
