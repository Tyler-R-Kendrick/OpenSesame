import type { NativeRecovery } from "./native-connector-schema.js";
import {
  CLIENT_SECRET,
  type NativeOAuthClientOwner,
  assertNativeOAuthClientOwner,
} from "./native-oauth-client-config.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import {
  discardVaultCredentials,
  readVaultCredentialsForWithdrawal,
} from "./vault-credential-custody.js";

export async function discardSupersededNativeOAuthClientSecret(
  obligation: NativeRecovery,
  id: string,
  owner: NativeOAuthClientOwner,
): Promise<void> {
  assertNativeOAuthClientOwner(owner);
  const record = requireNativeOAuthRecord(id);
  const credentials = obligation.credentials;
  if (
    obligation.kind !== "revoke" ||
    obligation.grant ||
    record.configuration.providerId !== obligation.providerId ||
    credentials?.phase !== "superseded" ||
    credentials.oauth_client_binding !== obligation.fingerprint ||
    credentials.oauth_client_vault !== owner.tomb ||
    !credentials.oauth_client_reference
  )
    throw new NativeOAuthError("expired");
  const held = readVaultCredentialsForWithdrawal(
    credentials.oauth_client_reference,
    obligation.fingerprint,
    ["clientSecret"],
    owner.tomb,
  );
  if (!held) return;
  CLIENT_SECRET.parse(held.fields.get("clientSecret"));
  await discardVaultCredentials(held, owner.tomb, () =>
    owner.transport.assertCurrent(),
  );
}
