import { randomString, sha256Base64Url } from "@opensesame/sdk-browser";
import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import { cancelNativeBrowserConsent } from "./native-browser-oauth-cancel.js";
import { verifyNativeBrowserCimd } from "./native-browser-oauth-cimd.js";
import { finishNativeBrowserAuthorization } from "./native-browser-oauth-finish.js";
import {
  browserOAuthClassification,
  browserOAuthEndpoints,
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import type { NativePending } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { nativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
/** PKCE state and verifier are sealed before any provider navigation or popup. */
import { nativeVercelAuthorizationUrl } from "./native-vercel-auth.js";

export async function beginNativeBrowserAuthorization(
  id: string,
  actor = "user",
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  assertNativeBrowserOAuthPolicy(record.configuration.providerId);
  if (
    record.configuration.method !== "oauth" ||
    record.privateState.recovery.length
  )
    throw new NativeOAuthError("cleanup");
  const transport = captureNativeAuthorizationTransport(
    nativeProviderTransport(),
  );
  const browser = nativeOAuthBrowserPort();
  const profile = requiredBrowserOAuthProfile(record.configuration.providerId);
  if (profile.mode === "google-token")
    throw new Error("Use the Google browser token authorization popup");
  const endpoints = browserOAuthEndpoints(profile, record.configuration);
  const scopes = browserOAuthScopes(profile, record.configuration, actor);
  await verifyNativeBrowserCimd(
    record.configuration,
    browser.redirectUri,
    transport,
  );
  const verifier = randomString(32);
  const state = randomString(32);
  const challenge = await sha256Base64Url(verifier);
  const now = Date.now();
  const pending: NativePending = {
    providerId: profile.id,
    actor,
    fingerprint: record.configuration.fingerprint,
    targetId: record.runtime.identity?.id,
    issuer: endpoints.issuer,
    endpoint: endpoints.token,
    clientId: record.configuration.clientId,
    state,
    verifier,
    redirectUri: browser.redirectUri,
    createdAt: now,
    expiresAt: now + 10 * 60_000,
    scopes,
  };
  const url = new URL(endpoints.authorization);
  const query =
    profile.mode === "openrouter-key"
      ? {
          callback_url: pending.redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }
      : {
          response_type: "code",
          client_id: pending.clientId ?? "",
          redirect_uri: pending.redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: scopes.join(" "),
        };
  for (const [name, value] of Object.entries(query))
    url.searchParams.set(name, value);
  if (profile.id === "dropbox")
    url.searchParams.set("token_access_type", "online");
  if (
    ["microsoft", "microsoft-teams", "vercel", "auth0", "okta"].includes(
      profile.id,
    )
  )
    url.searchParams.set("nonce", state);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      transport.assertCurrent();
      current.privateState.pending[actor] = pending;
      current.privateState.verification = null;
      return current;
    },
  );
  const callback = await launchNativeBrowserConsent(id, pending, url.href);
  if (callback) await finishNativeBrowserAuthorization(callback);
}
async function launchNativeBrowserConsent(
  id: string,
  pending: NativePending,
  fallbackUrl: string,
): Promise<string | null> {
  const transport = captureNativeAuthorizationTransport(
    nativeProviderTransport(),
  );
  const browser = nativeOAuthBrowserPort();
  try {
    transport.assertCurrent();
    const authorizationUrl =
      pending.providerId === "vercel"
        ? await nativeVercelAuthorizationUrl(pending, "query")
        : fallbackUrl;
    if (browser.authorize)
      return await browser.authorize(authorizationUrl, {
        state: pending.state,
        expiresAt: pending.expiresAt,
      });
    browser.navigate(authorizationUrl);
    return null;
  } catch (error) {
    await cancelNativeBrowserConsent(id, pending.state);
    throw error;
  }
}
