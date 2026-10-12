/** A token mint is a revoke obligation; an unobserved reply is never called a revoked grant. */
import { NativeApiError } from "./native-api-http.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  nativeVaultClassification,
  requireNativeVault,
} from "./native-vault-session.js";

export async function prepareVaultExchange(
  connectionId: string,
  intentId: string,
) {
  const record = requireNativeVault(connectionId);
  await updateNativeConnector(
    connectionId,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      const intent = current.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (!intent || intent.grant)
        throw new Error("The authorization exchange changed");
      intent.kind = "revoke";
      return current;
    },
  );
}
export async function recordVaultExchangeFailure(
  connectionId: string,
  intentId: string,
  denied: boolean,
) {
  const record = requireNativeVault(connectionId);
  await updateNativeConnector(
    connectionId,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      const intent = current.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (!intent || intent.grant)
        throw new Error("The authorization exchange changed");
      intent.credentials = {
        ...intent.credentials,
        phase: denied ? "exchange-denied" : "exchange-unobserved",
        deadline: "0",
      };
      current.configuration.parameters.authorization_outcome = denied
        ? "denied"
        : "exchange-unobserved";
      return current;
    },
  );
}
export function vaultExchangeDenied(error: Error): boolean {
  return (
    error instanceof NativeApiError && error.status >= 400 && error.status < 500
  );
}
export async function recordVaultNoHeldGrant(
  connectionId: string,
  denied: boolean,
) {
  const record = requireNativeVault(connectionId);
  await updateNativeConnector(
    connectionId,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      current.configuration.parameters.authorization_outcome = denied
        ? "denied"
        : "exchange-unobserved";
      current.privateState.credentials = Object.fromEntries(
        Object.entries(current.privateState.credentials).filter(
          ([key]) => key !== "oidc_nonce",
        ),
      );
      return current;
    },
  );
}
