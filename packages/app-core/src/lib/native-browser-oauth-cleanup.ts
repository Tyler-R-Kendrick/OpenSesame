/** Revocation uses provider-documented routes; provider settings remain explicit when no route exists. */
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import {
  browserOAuthClassification,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { refreshNativeBrowserToken } from "./native-browser-oauth-token.js";
import type {
  NativeCleanupContext,
  NativeCleanupOutcome,
  NativeProviderCleanup,
} from "./native-connector-lifecycle.js";
import type { NativeRecovery } from "./native-connector-schema.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeOAuthHttp } from "./native-oauth-http.js";
import {
  markNativeOAuthMutationInFlight,
  nativeOAuthMutationInFlight,
  retainNativeOAuthRotationForRetry,
  retryRetainedNativeOAuthGrants,
} from "./native-oauth-session.js";

async function proveRefreshRevoked(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport,
): Promise<void> {
  const grant = obligation.grant;
  if (!grant?.refreshToken) throw new NativeOAuthError("cleanup");
  const finishMutation = markNativeOAuthMutationInFlight(
    context.connectionId,
    obligation.id,
  );
  try {
    let issued: Awaited<ReturnType<typeof refreshNativeBrowserToken>>;
    try {
      issued = await refreshNativeBrowserToken(
        context.configuration,
        grant.refreshToken,
        transport,
      );
    } catch (error) {
      if (
        error instanceof NativeOAuthError &&
        error.oauthError === "invalid_grant"
      )
        return;
      throw new NativeOAuthError("cleanup");
    }
    const rotated = {
      ...grant,
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken ?? grant.refreshToken,
      expiresAt: issued.expiresAt,
      scopes: issued.scopes,
    };
    try {
      await context.persistGrantRotation(rotated);
    } catch (error) {
      retainNativeOAuthRotationForRetry(
        context.connectionId,
        obligation.id,
        rotated,
        browserOAuthClassification,
      );
      throw error;
    }
    throw new NativeOAuthError("cleanup");
  } finally {
    finishMutation();
  }
}
async function proveSettingsRevocation(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport,
): Promise<NativeCleanupOutcome> {
  const grant = obligation.grant;
  if (!grant) throw new NativeOAuthError("cleanup");
  const endpoints = new Map([
    ["microsoft", "https://graph.microsoft.com/v1.0/me"],
    ["microsoft-teams", "https://graph.microsoft.com/v1.0/me"],
    ["spotify", "https://api.spotify.com/v1/me"],
    ["openrouter", "https://openrouter.ai/api/v1/key"],
  ]);
  const endpoint = endpoints.get(obligation.providerId);
  if (!endpoint) throw new NativeOAuthError("cleanup");
  if (grant.refreshToken)
    await proveRefreshRevoked(obligation, context, transport);
  try {
    await nativeApiHttp(
      {
        url: endpoint,
        method: "GET",
        headers: new Headers({ authorization: `Bearer ${grant.accessToken}` }),
      },
      transport,
    );
  } catch (error) {
    if (
      error instanceof NativeApiError &&
      error.code === "authorization" &&
      !grant.refreshToken
    )
      return "provider-revoked";
    throw new NativeOAuthError("cleanup");
  }
  throw new NativeOAuthError("cleanup");
}
async function revokeForm(
  obligation: NativeRecovery,
  transport: NativeProviderTransport,
): Promise<void> {
  const profile = requiredBrowserOAuthProfile(obligation.providerId);
  const grant = obligation.grant;
  if (!grant || !profile.revocationEndpoint)
    throw new NativeOAuthError("cleanup");
  const tokens = [
    ...new Set(
      [grant.refreshToken, grant.accessToken].filter(
        (token): token is string => !!token,
      ),
    ),
  ];
  for (const token of tokens) {
    const body = new URLSearchParams({ token });
    if (["gitlab", "workos"].includes(profile.id))
      body.set("client_id", grant.clientId ?? "");
    const reply = await nativeOAuthHttp(
      profile.revocationEndpoint,
      body,
      transport,
      undefined,
      false,
    );
    if (reply.status < 200 || reply.status >= 300)
      throw new NativeOAuthError("cleanup");
  }
}
async function revokeRefreshGrant(
  obligation: NativeRecovery,
  transport: NativeProviderTransport,
): Promise<void> {
  const grant = obligation.grant;
  const profile = requiredBrowserOAuthProfile(obligation.providerId);
  if (!grant?.refreshToken) throw new NativeOAuthError("cleanup");
  const body = new URLSearchParams({
    client_id: grant.clientId ?? "",
    token: grant.refreshToken,
    token_type_hint: "refresh_token",
  });
  const reply = await nativeOAuthHttp(
    profile.revocationEndpoint ?? "",
    body,
    transport,
    undefined,
    false,
  );
  if (reply.status < 200 || reply.status >= 300)
    throw new NativeOAuthError("cleanup");
}
function assertCleanupSettled(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
): void {
  const phase = obligation.credentials?.phase ?? "";
  if (!["exchange", "refresh"].includes(phase)) return;
  if (
    Number(obligation.credentials?.deadline) > Date.now() ||
    nativeOAuthMutationInFlight(context.connectionId, obligation.id)
  )
    throw new NativeOAuthError("cleanup");
}
async function revokeAutomaticGrant(
  obligation: NativeRecovery,
  transport: NativeProviderTransport,
): Promise<void> {
  const profile = requiredBrowserOAuthProfile(obligation.providerId);
  if (profile.revoke === "refresh-grant") {
    await revokeRefreshGrant(obligation, transport);
    return;
  }
  if (profile.revoke !== "dropbox") {
    await revokeForm(obligation, transport);
    return;
  }
  const grant = obligation.grant;
  if (!grant) throw new NativeOAuthError("cleanup");
  const reply = await nativeOAuthHttp(
    profile.revocationEndpoint ?? "",
    "null",
    transport,
    grant.accessToken,
    false,
  );
  if (reply.status !== 200 && reply.status !== 401)
    throw new NativeOAuthError("cleanup");
}
export async function cleanupNativeBrowserOAuth(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeCleanupOutcome> {
  assertCleanupSettled(obligation, context);
  const profile = requiredBrowserOAuthProfile(obligation.providerId);
  if (!obligation.grant) throw new NativeOAuthError("cleanup");
  if (profile.revoke === "settings") {
    if (obligation.kind === "revoke") return "local-credential-forgotten";
    return proveSettingsRevocation(obligation, context, transport);
  }
  await revokeAutomaticGrant(obligation, transport);
  return "provider-revoked";
}
export const nativeBrowserOAuthCleanup: NativeProviderCleanup = {
  classification: browserOAuthClassification,
  prepare: retryRetainedNativeOAuthGrants,
  cleanup: cleanupNativeBrowserOAuth,
};
export function nativeBrowserOAuthCleanupInstruction(
  providerId: string,
): { url: string; message: string } | null {
  const profile = requiredBrowserOAuthProfile(providerId);
  return profile.revoke === "settings" && profile.settingsUrl
    ? {
        url: profile.settingsUrl,
        message: `Revoke this application in ${profile.name} authorization settings. Disconnecting locally removes the saved credential; provider authorization remains until you revoke it there.`,
      }
    : null;
}
