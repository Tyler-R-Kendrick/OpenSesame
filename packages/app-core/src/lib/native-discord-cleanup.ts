import type {
  NativeCleanupContext,
  NativeCleanupOutcome,
} from "./native-connector-lifecycle.js";
/** Discord's client-authenticated revocation route is not called with a pretend public secret. */
import type { NativeRecovery } from "./native-connector-schema.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthMutationInFlight } from "./native-oauth-session.js";
export function cleanupNativeDiscordAuthorization(
  entry: NativeRecovery,
  context: NativeCleanupContext,
): NativeCleanupOutcome {
  if (
    entry.providerId !== "discord" ||
    entry.kind !== "revoke" ||
    nativeOAuthMutationInFlight(context.connectionId, entry.id)
  )
    throw new NativeOAuthError("cleanup");
  if (
    !entry.grant &&
    !["exchange-unobserved", "exchange-denied"].includes(
      entry.credentials?.phase ?? "",
    )
  )
    throw new NativeOAuthError("cleanup");
  if (
    entry.grant &&
    (entry.grant.issuer !== "https://discord.com" ||
      entry.grant.endpoint !== "https://discord.com/api/oauth2/token" ||
      entry.grant.clientId !== context.configuration.clientId ||
      entry.grant.fingerprint !== context.configuration.fingerprint)
  )
    throw new NativeOAuthError("cleanup");
  return "local-credential-forgotten";
}
