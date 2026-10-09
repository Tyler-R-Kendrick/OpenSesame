import type { NativeGrant } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import type { NativeLocalInstanceFacts } from "./native-local-instance-http.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import type { NativeVaultOidcInput } from "./native-vault-http.js";
import {
  nativeVaultClassification,
  requireNativeVault,
} from "./native-vault-session.js";

export async function commitNativeVaultGrant(
  connectionId: string,
  intentId: string,
  state: string,
  grant: NativeGrant,
  facts: NativeLocalInstanceFacts,
  input: NativeVaultOidcInput,
  transport: NativeProviderTransport,
) {
  const record = requireNativeVault(connectionId);
  return updateNativeConnector(
    connectionId,
    nativeOAuthGuard(record),
    nativeVaultClassification,
    (current) => {
      transport.assertCurrent();
      const intent = current.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (
        !intent?.grant ||
        intent.grant.accessToken !== grant.accessToken ||
        intent.fingerprint !== current.configuration.fingerprint
      )
        throw new Error(
          "The authorization changed before verification completed",
        );
      const previous = current.privateState.grants.user;
      if (previous)
        current.privateState.recovery.push({
          id: `vault-replace:${state}`,
          kind: "revoke",
          providerId: previous.providerId,
          actor: previous.actor,
          fingerprint: previous.fingerprint,
          targetId: previous.targetId ?? input.providerId,
          grant: {
            ...previous,
            targetId: previous.targetId ?? input.providerId,
          },
          credentials: { namespace: input.namespace },
        });
      current.configuration.parameters = Object.fromEntries(
        Object.entries(current.configuration.parameters).filter(
          ([key]) => key !== "authorization_outcome",
        ),
      );
      current.privateState.grants.user = {
        ...grant,
        targetId: facts.entityId ?? input.providerId,
        expiresAt: facts.expiresAt,
      };
      current.privateState.credentials.api_key = grant.accessToken;
      current.privateState.credentials = Object.fromEntries(
        Object.entries(current.privateState.credentials).filter(
          ([name]) => name !== "oidc_nonce",
        ),
      );
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      const verifiedAt = Math.max(
        facts.verifiedAt,
        (current.runtime.verifiedAt ?? 0) + 1,
      );
      current.privateState.verification = {
        fingerprint: current.configuration.fingerprint,
        verifiedAt,
        kind: "provider",
      };
      current.runtime = {
        verifiedAt,
        identity: facts.entityId
          ? {
              id: facts.entityId,
              label: facts.tokenLabel,
              kind: "entity",
              assurance: "account-verified",
            }
          : null,
        targets: [],
        grants: [
          {
            actor: "user",
            label: facts.tokenLabel,
            permissionState: "provider-managed",
            grantedScopes: [],
            expiresAt: facts.expiresAt,
            needsReauth: false,
          },
        ],
      };
      return current;
    },
    () => transport.assertCurrent(),
  );
}
