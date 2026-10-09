/** Google's documented token model uses a real browser popup, without a refresh token. */
import { randomString } from "@opensesame/sdk-browser";
import { retainAndVerifyNativeBrowserToken } from "./native-browser-oauth-finish.js";
import {
  browserOAuthClassification,
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import type { NativePending } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { nativeProviderTransport } from "./native-connector-transport.js";
import {
  nativeOAuthBrowserPort,
  nativeOAuthRedirectUri,
} from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
  nativeOAuthObligation,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

export async function beginNativeGoogleAuthorization(
  id: string,
  actor = "user",
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  const clientId = record.configuration.clientId;
  const request = nativeOAuthBrowserPort().googleToken;
  if (
    record.configuration.providerId !== "google" ||
    record.configuration.method !== "oauth" ||
    !clientId ||
    !request
  )
    throw new NativeOAuthError("provider");
  if (record.privateState.recovery.length)
    throw new NativeOAuthError("cleanup");
  const transport = nativeProviderTransport();
  const scopes = browserOAuthScopes(
    requiredBrowserOAuthProfile("google"),
    record.configuration,
    actor,
  );
  const now = Date.now();
  const pending: NativePending = {
    providerId: "google",
    actor,
    fingerprint: record.configuration.fingerprint,
    targetId: record.runtime.identity?.id,
    clientId,
    issuer: "https://accounts.google.com",
    endpoint: "https://oauth2.googleapis.com/token",
    state: randomString(32),
    verifier: randomString(32),
    redirectUri: nativeOAuthRedirectUri(),
    createdAt: now,
    expiresAt: now + 600_000,
    scopes,
  };
  const intent = nativeOAuthObligation(pending, record.runtime.identity?.id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      transport.assertCurrent();
      current.privateState.recovery.push(intent);
      current.privateState.verification = null;
      return current;
    },
  );
  const finishMutation = markNativeOAuthMutationInFlight(id, intent.id);
  try {
    await request(
      clientId,
      scopes,
      async (token) => {
        await retainAndVerifyNativeBrowserToken(
          id,
          intent.id,
          pending,
          token,
          transport,
        );
      },
      transport.assertCurrent,
    );
  } catch (error) {
    if (error instanceof NativeOAuthError && error.code === "denied") {
      const current = requireNativeOAuthRecord(id);
      await updateNativeConnector(
        id,
        nativeOAuthGuard(current),
        browserOAuthClassification(current.configuration),
        (saved) => {
          saved.privateState.recovery = saved.privateState.recovery.filter(
            (entry) => entry.id !== intent.id || !!entry.grant,
          );
          return saved;
        },
      );
    }
    throw error;
  } finally {
    finishMutation();
  }
}
