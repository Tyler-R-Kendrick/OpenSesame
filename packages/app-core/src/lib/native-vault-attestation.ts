/** Administrator confirmation forgets uncertain local authority without claiming provider proof. */
import {
  type NativeRecovery,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import { nativeProviderTransport } from "./native-connector-transport.js";
import {
  forgetRetainedNativeOAuthGrant,
  nativeOAuthGuard,
  nativeOAuthMutationInFlight,
} from "./native-oauth-session.js";
import {
  nativeVaultClassification,
  nativeVaultInput,
  requireNativeVault,
} from "./native-vault-session.js";

function vaultRecovery(id: string, recoveryId: string) {
  const record = requireNativeVault(id);
  const input = nativeVaultInput(id);
  const entry = record.privateState.recovery.find(
    (entry) => entry.id === recoveryId,
  );
  if (
    !entry ||
    entry.kind !== "revoke" ||
    entry.actor !== "user" ||
    entry.providerId !== input.providerId ||
    entry.fingerprint !== record.configuration.fingerprint ||
    (entry.grant &&
      (entry.grant.kind !== "oidc" ||
        entry.grant.endpoint !== input.endpoint)) ||
    (entry.credentials?.namespace !== undefined &&
      entry.credentials.namespace !== input.namespace)
  )
    throw new Error(
      "Provider revocation confirmation belongs to another Vault connection",
    );
  return { record, input, entry };
}

function canConfirm(
  record: NativeConnectorRecord,
  entry: NativeRecovery,
): boolean {
  return (
    !nativeOAuthMutationInFlight(record.connectionId, entry.id) &&
    Object.keys(record.privateState.pending).length === 0 &&
    !(
      entry.credentials?.phase === "exchange" &&
      Number(entry.credentials.deadline) > Date.now()
    )
  );
}

export function nativeVaultRevocationInstructions(
  id: string,
  recoveryId: string,
) {
  const { record, input, entry } = vaultRecovery(id, recoveryId);
  const name = input.providerId === "vault" ? "HashiCorp Vault" : "OpenBao";
  return {
    url:
      input.providerId === "vault"
        ? "https://developer.hashicorp.com/vault/api-docs/auth/token#revoke-a-token"
        : "https://openbao.org/api-docs/auth/token/#revoke-a-token",
    message: `Ask the ${name} administrator for ${input.endpoint} to revoke this connection's OIDC-issued token, or confirm that it has already expired or been revoked. Namespace: ${input.namespace || "root"}; auth mount: ${input.authMount}; role: ${input.role || "provider default"}. Confirm only after that administrator action. This confirmation only forgets the selected local recovery credential; it does not verify provider revocation or a working connection.`,
    acknowledgementLabel:
      "An administrator revoked this connection token or confirmed it is expired",
    canConfirm: canConfirm(record, entry),
  };
}

export async function attestNativeVaultRevocation(
  id: string,
  recoveryId: string,
) {
  const { record, entry } = vaultRecovery(id, recoveryId);
  const transport = nativeProviderTransport();
  const assertReady = () => {
    transport.assertCurrent();
    const current = vaultRecovery(id, recoveryId);
    if (!canConfirm(current.record, current.entry))
      throw new Error(
        "Provider authorization is still pending; retry confirmation after it settles",
      );
  };
  assertReady();
  const expected = JSON.stringify(entry);
  const result = await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      assertReady();
      if (
        JSON.stringify(
          current.privateState.recovery.find((item) => item.id === recoveryId),
        ) !== expected
      )
        throw new Error(
          "Provider cleanup changed; review it before confirming",
        );
      current.privateState.recovery = current.privateState.recovery.filter(
        (item) => item.id !== recoveryId,
      );
      if (current.privateState.credentials.api_key === entry.grant?.accessToken)
        current.privateState.credentials = Object.fromEntries(
          Object.entries(current.privateState.credentials).filter(
            ([name]) => name !== "api_key",
          ),
        );
      current.privateState.verification = null;
      current.runtime = emptyNativeRuntime();
      return current;
    },
    assertReady,
  );
  forgetRetainedNativeOAuthGrant(id, recoveryId);
  return result;
}
