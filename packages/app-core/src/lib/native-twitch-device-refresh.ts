/** Twitch refresh codes are single-use; preserve both the old access token and the rotated pair. */
import { randomString } from "@opensesame/sdk-browser";
import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import {
  browserOAuthClassification,
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import { refreshNativeBrowserToken } from "./native-browser-oauth-token.js";
import { verifyNativeBrowserOAuth } from "./native-browser-oauth-verify.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import type {
  NativeGrant,
  NativePending,
  NativeRecovery,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { nativeOAuthRedirectUri } from "./native-oauth-browser-port.js";
import { commitNativeOAuthGrant } from "./native-oauth-commit.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  forgetRetainedNativeOAuthGrant,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
} from "./native-oauth-session.js";
import { cleanupNativeTwitchDevice } from "./native-twitch-device-cleanup.js";
import { requireNativeTwitchDevice } from "./native-twitch-device-state.js";

async function prepareTwitchRefresh(
  initial: NativeConnectorRecord,
  old: NativeGrant,
  transport: NativeProviderTransport,
): Promise<NativeRecovery> {
  const targetId = old.targetId ?? initial.runtime.identity?.id ?? "twitch";
  const intent: NativeRecovery = {
    id: `twitch-refresh:${randomString(32)}`,
    kind: "revoke",
    providerId: "twitch",
    actor: "user",
    fingerprint: old.fingerprint,
    targetId,
    grant: { ...old, targetId },
    credentials: {
      phase: "refresh",
      deadline: String(Date.now() + 60_000),
      identity_id: initial.runtime.identity?.id ?? "",
    },
  };
  await updateNativeConnector(
    initial.connectionId,
    nativeOAuthGuard(initial),
    browserOAuthClassification(initial.configuration),
    (record) => {
      transport.assertCurrent();
      record.privateState.verification = null;
      record.privateState.recovery.push(intent, {
        ...intent,
        id: `old-access:${intent.id}`,
        credentials: { phase: "old-access", device_parent: intent.id },
      });
      return record;
    },
  );
  return intent;
}
function twitchRefreshPending(
  record: NativeConnectorRecord,
  grant: NativeGrant,
): NativePending {
  return {
    providerId: "twitch",
    actor: "user",
    fingerprint: record.configuration.fingerprint,
    targetId: grant.targetId,
    issuer: "https://id.twitch.tv",
    endpoint: "https://id.twitch.tv/oauth2/token",
    clientId: record.configuration.clientId,
    state: randomString(32),
    verifier: randomString(32),
    redirectUri: nativeOAuthRedirectUri(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    scopes: browserOAuthScopes(
      requiredBrowserOAuthProfile("twitch"),
      record.configuration,
      "user",
    ),
  };
}
async function sealTwitchRotation(
  id: string,
  intent: NativeRecovery,
  grant: NativeGrant,
  transport: NativeProviderTransport,
  onCompensated: () => void,
) {
  try {
    await journalNativeOAuthGrant(
      id,
      intent.id,
      grant,
      browserOAuthClassification,
    );
  } catch {
    const record = requireNativeTwitchDevice(id);
    await cleanupNativeTwitchDevice(
      { ...intent, grant, credentials: { phase: "verify", deadline: "0" } },
      {
        connectionId: id,
        configuration: record.configuration,
        persistGrantRotation: async () => {
          throw new NativeOAuthError("storage");
        },
      },
      transport,
    );
    forgetRetainedNativeOAuthGrant(id, intent.id);
    onCompensated();
    throw new NativeOAuthError("storage");
  }
  const record = requireNativeTwitchDevice(id);
  const redundant = record.privateState.recovery.find(
    (entry) => entry.id === `old-access:${intent.id}`,
  );
  if (redundant?.grant?.accessToken !== grant.accessToken) return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== redundant.id,
      );
      return current;
    },
  );
}
async function recordTwitchRefreshFailure(
  id: string,
  intentId: string,
  denied: boolean,
) {
  const current = requireNativeTwitchDevice(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    browserOAuthClassification(current.configuration),
    (record) => {
      const intent = record.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (intent) intent.credentials = { ...intent.credentials, deadline: "0" };
      record.configuration.parameters.authorization_outcome = denied
        ? "refresh-denied"
        : "refresh-unobserved";
      return record;
    },
  );
}
async function settleObservedTwitchRefreshFailure(
  id: string,
  intentId: string,
) {
  const record = requireNativeTwitchDevice(id);
  const intent = record.privateState.recovery.find(
    (entry) => entry.id === intentId,
  );
  if (intent?.credentials?.phase !== "refresh") return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      const retained = current.privateState.recovery.find(
        (entry) => entry.id === intentId,
      );
      if (retained)
        retained.credentials = {
          ...retained.credentials,
          phase: "verify",
          deadline: "0",
        };
      return current;
    },
  );
}
export async function refreshNativeTwitchAuthorization(
  initial: NativeConnectorRecord,
  baseTransport: NativeProviderTransport,
): Promise<void> {
  const transport = captureNativeAuthorizationTransport(baseTransport);
  transport.assertCurrent();
  const old = initial.privateState.grants.user;
  if (
    initial.configuration.providerId !== "twitch" ||
    !old?.refreshToken ||
    initial.privateState.recovery.length ||
    Object.keys(initial.privateState.pending).length
  )
    throw new NativeOAuthError("cleanup");
  const id = initial.connectionId;
  const intent = await prepareTwitchRefresh(initial, old, transport);
  const finishMutation = markNativeOAuthMutationInFlight(id, intent.id);
  let observed = false;
  let compensated = false;
  let completed = false;
  try {
    const token = await refreshNativeBrowserToken(
      initial.configuration,
      old.refreshToken,
      transport,
    );
    observed = true;
    const grant: NativeGrant = {
      ...old,
      targetId: intent.targetId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
    };
    await sealTwitchRotation(id, intent, grant, baseTransport, () => {
      compensated = true;
    });
    transport.assertCurrent();
    const record = requireNativeTwitchDevice(id);
    const retained = record.privateState.recovery.find(
      (entry) => entry.id === intent.id,
    )?.grant;
    if (!retained) throw new NativeOAuthError("storage");
    const verified = await verifyNativeBrowserOAuth(
      record.configuration,
      twitchRefreshPending(record, grant),
      token,
      transport,
      initial.runtime.identity ?? undefined,
    );
    await commitNativeOAuthGrant(
      id,
      intent.id,
      verified,
      browserOAuthClassification,
      transport,
      { revision: record.revision, grant: retained },
    );
    completed = true;
  } catch (error) {
    if (compensated) await settleObservedTwitchRefreshFailure(id, intent.id);
    if (!observed)
      await recordTwitchRefreshFailure(
        id,
        intent.id,
        error instanceof NativeOAuthError &&
          error.oauthError === "invalid_grant",
      );
    throw error;
  } finally {
    finishMutation();
    if (completed) await retryNativeConnectorCleanup(id);
    else await retryNativeConnectorCleanup(id).catch(() => undefined);
  }
}
