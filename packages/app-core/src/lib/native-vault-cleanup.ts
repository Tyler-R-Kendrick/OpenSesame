/** OpenSesame-issued Vault sessions are revoked remotely before removing their sealed authority. */
import { NativeApiError } from "./native-api-http.js";
import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import {
  lookupNativeLocalInstance,
  revokeNativeLocalInstanceSelf,
} from "./native-local-instance-http.js";
import { nativeLocalInstanceCleanup } from "./native-local-instance.js";
import {
  nativeOAuthMutationInFlight,
  retryRetainedNativeOAuthGrants,
} from "./native-oauth-session.js";
import { recordVaultNoHeldGrant } from "./native-vault-intent.js";
import { nativeVaultClassification } from "./native-vault-session.js";

export function nativeVaultCleanup(
  providerId: "vault" | "openbao",
  transport: NativeProviderTransport = nativeProviderTransport(),
): NativeProviderCleanup {
  const legacy = nativeLocalInstanceCleanup(providerId, transport);
  return {
    classification: (configuration) =>
      configuration.method === "oidc"
        ? nativeVaultClassification
        : legacy.classification(configuration),
    credentialSlots: (configuration) =>
      configuration.method === "oidc" ? [] : ["api_key"],
    prepare: retryRetainedNativeOAuthGrants,
    cleanup: async (obligation, context) => {
      if (context.configuration.method !== "oidc")
        return legacy.cleanup(obligation, context);
      if (
        obligation.providerId !== providerId ||
        !["configure", "revoke"].includes(obligation.kind)
      )
        throw new Error("This cleanup belongs to another provider");
      if (
        nativeOAuthMutationInFlight(context.connectionId, obligation.id) ||
        (!obligation.grant &&
          Number(obligation.credentials?.deadline) > Date.now())
      )
        throw new Error("The authorization exchange is still settling");
      const grant = obligation.grant;
      if (!grant) {
        await recordVaultNoHeldGrant(
          context.connectionId,
          obligation.credentials?.phase === "exchange-denied",
        );
        return "local-credential-forgotten";
      }
      if (grant.kind !== "oidc")
        throw new Error("This cleanup belongs to another authorization method");
      await revokeVaultGrant(
        grant.endpoint ?? "",
        obligation.credentials?.namespace ??
          context.configuration.parameters.namespace ??
          "",
        grant.accessToken,
        transport,
      );
      return "provider-revoked";
    },
  };
}

async function revokeVaultGrant(
  endpoint: string,
  namespace: string,
  token: string,
  transport: NativeProviderTransport,
) {
  try {
    await revokeNativeLocalInstanceSelf(endpoint, namespace, token, transport);
  } catch (error) {
    if (
      !(error instanceof NativeApiError) ||
      ![401, 403].includes(error.status)
    )
      throw error;
    try {
      await lookupNativeLocalInstance(endpoint, namespace, token, transport);
    } catch (lookupError) {
      if (
        lookupError instanceof NativeApiError &&
        [401, 403].includes(lookupError.status)
      )
        return;
      throw lookupError;
    }
    throw error;
  }
}
