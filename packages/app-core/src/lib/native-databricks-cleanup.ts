/** Databricks revokes consent separately from still-valid issued tokens. */
import type {
  NativeCleanupContext,
  NativeCleanupOutcome,
} from "./native-connector-lifecycle.js";
import type { NativeRecovery } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeDatabricksEndpoints } from "./native-databricks-provider.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthMutationInFlight } from "./native-oauth-session.js";
export async function cleanupNativeDatabricksAuthorization(
  entry: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport,
): Promise<NativeCleanupOutcome> {
  if (
    entry.providerId !== "databricks" ||
    entry.kind !== "revoke" ||
    nativeOAuthMutationInFlight(context.connectionId, entry.id)
  )
    throw new NativeOAuthError("cleanup");
  const grant = entry.grant;
  if (!grant) {
    if (
      !["exchange-unobserved", "exchange-denied"].includes(
        entry.credentials?.phase ?? "",
      )
    )
      throw new NativeOAuthError("cleanup");
    return "local-credential-forgotten";
  }
  const endpoints = nativeDatabricksEndpoints(
    context.configuration.parameters.domain ?? "",
  );
  if (
    grant.issuer !== endpoints.issuer ||
    grant.endpoint !== endpoints.token ||
    grant.clientId !== context.configuration.clientId ||
    grant.fingerprint !== context.configuration.fingerprint
  )
    throw new NativeOAuthError("cleanup");
  return revokeDatabricksConsent(
    entry,
    context,
    transport,
    endpoints.token,
    grant.accessToken,
  );
}
async function revokeDatabricksConsent(
  entry: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport,
  tokenEndpoint: string,
  accessToken: string,
): Promise<NativeCleanupOutcome> {
  const integrationId =
    entry.credentials?.integration_id ??
    context.configuration.parameters.integration_id;
  if (integrationId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(integrationId))
      throw new NativeOAuthError("provider");
    transport.assertCurrent();
    const response = await transport.fetch(
      `${new URL(tokenEndpoint).origin}/api/2.0/oauth-app-integrations/${encodeURIComponent(integrationId)}/user-consent/me`,
      {
        method: "DELETE",
        headers: new Headers({
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        }),
        mode: "cors",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(15000),
      },
    );
    transport.assertCurrent();
    if (response.redirected || !response.ok)
      throw new NativeOAuthError("cleanup");
  }
  return "local-credential-forgotten";
}
