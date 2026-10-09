/** Bearer return is encrypted and journaled before its callback is acknowledged. */
import { randomString } from "@opensesame/sdk-browser";
import { recordApprovedNativeExchangeFailure } from "./native-approved-auth-recovery.js";
import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import {
  retainAndVerifyNativeBrowserToken,
  retainNativeBrowserToken,
} from "./native-browser-oauth-finish.js";
import {
  browserOAuthClassification,
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import type { NativePending } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import { nativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
  nativeOAuthObligation,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
export async function beginNativeDiscordAuthorization(
  id: string,
  actor = "user",
): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  const browser = nativeOAuthBrowserPort();
  if (
    record.configuration.providerId !== "discord" ||
    record.configuration.method !== "oauth" ||
    !record.configuration.clientId ||
    !browser.prepareImplicitAuthorization
  )
    throw new NativeOAuthError("provider");
  if (record.privateState.recovery.length)
    throw new NativeOAuthError("cleanup");
  const transport = captureNativeAuthorizationTransport(
    nativeProviderTransport(),
  );
  const prepared = await browser.prepareImplicitAuthorization("discord");
  try {
    const now = Date.now();
    const pending: NativePending = {
      providerId: "discord",
      actor,
      fingerprint: record.configuration.fingerprint,
      targetId: record.runtime.identity?.id,
      clientId: record.configuration.clientId,
      issuer: "https://discord.com",
      endpoint: "https://discord.com/api/oauth2/token",
      state: prepared.state,
      verifier: randomString(32),
      redirectUri: prepared.redirectUri,
      createdAt: now,
      expiresAt: now + 600000,
      scopes: browserOAuthScopes(
        requiredBrowserOAuthProfile("discord"),
        record.configuration,
        actor,
      ),
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
    const finish = markNativeOAuthMutationInFlight(id, intent.id);
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      response_type: "token",
      client_id: pending.clientId ?? "",
      redirect_uri: pending.redirectUri,
      state: pending.state,
      scope: pending.scopes.join(" "),
      prompt: "consent",
    }).toString();
    try {
      const token = await prepared.authorize(url.href, {
        expiresAt: pending.expiresAt,
        retain: async (token) => {
          await retainNativeBrowserToken(
            id,
            intent.id,
            pending,
            token,
            transport,
          );
        },
      });
      await retainAndVerifyNativeBrowserToken(
        id,
        intent.id,
        pending,
        token,
        transport,
        true,
      );
    } catch (error) {
      if (error instanceof Error)
        await recordApprovedNativeExchangeFailure(id, intent.id, error);
      throw error;
    } finally {
      finish();
    }
  } finally {
    prepared.close();
  }
}
