/** Refresh has a durable mutation intent and retains the rotated pair before activation. */
import { randomString } from "@opensesame/sdk-browser";
import {
  browserOAuthClassification,
  browserOAuthEndpoints,
  browserOAuthScopes,
  requiredBrowserOAuthProfile,
} from "./native-browser-oauth-profile.js";
import {
  type IssuedNativeOAuthToken,
  refreshNativeBrowserToken,
} from "./native-browser-oauth-token.js";
import { verifyNativeBrowserOAuth } from "./native-browser-oauth-verify.js";
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
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

export async function refreshNativeBrowserAuthorization(
  initial: NativeConnectorRecord,
  transport: NativeProviderTransport,
): Promise<void> {
  const old = initial.privateState.grants.user;
  const profile = requiredBrowserOAuthProfile(initial.configuration.providerId);
  if (
    !old?.refreshToken ||
    !profile.refresh ||
    initial.privateState.recovery.length
  )
    throw new NativeOAuthError("expired");
  const id = initial.connectionId;
  const redirectUri = nativeOAuthRedirectUri();
  const targetId = old.targetId ?? initial.configuration.providerId;
  const credentials = {
    phase: "refresh",
    deadline: String(Date.now() + 60_000),
    identity_id: initial.runtime.identity?.id ?? "",
  };
  const intent: NativeRecovery = {
    id: `oauth-refresh:${randomString(32)}`,
    kind: "configure",
    providerId: old.providerId,
    actor: old.actor,
    fingerprint: old.fingerprint,
    targetId,
    grant: { ...old, targetId },
    credentials,
  };
  await updateNativeConnector(
    id,
    nativeOAuthGuard(initial),
    browserOAuthClassification(initial.configuration),
    (current) => {
      transport.assertCurrent();
      current.privateState.recovery.push(intent);
      current.privateState.verification = null;
      return current;
    },
  );
  const token = await refreshAndJournal(
    initial,
    old,
    old.refreshToken,
    intent,
    targetId,
    transport,
  );
  transport.assertCurrent();
  const current = requireNativeOAuthRecord(id);
  const retained = current.privateState.recovery.find(
    (entry) => entry.id === intent.id,
  )?.grant;
  if (!retained) throw new NativeOAuthError("storage");
  const pending = refreshedPending(current, old, targetId, redirectUri);
  const verified = await verifyNativeBrowserOAuth(
    current.configuration,
    pending,
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
    { revision: current.revision, grant: retained },
  );
}
async function refreshAndJournal(
  initial: NativeConnectorRecord,
  old: NativeGrant,
  refreshToken: string,
  intent: NativeRecovery,
  targetId: string,
  transport: NativeProviderTransport,
): Promise<IssuedNativeOAuthToken> {
  const finishMutation = markNativeOAuthMutationInFlight(
    initial.connectionId,
    intent.id,
  );
  try {
    let issued: IssuedNativeOAuthToken;
    try {
      issued = await refreshNativeBrowserToken(
        initial.configuration,
        refreshToken,
        transport,
      );
    } catch (error) {
      if (
        error instanceof NativeOAuthError &&
        error.oauthError === "invalid_grant"
      )
        await markExpiredRefresh(initial.connectionId, intent.id);
      throw error;
    }
    const token = {
      ...issued,
      refreshToken: issued.refreshToken ?? old.refreshToken,
      scopes: issued.scopes ?? old.scopes,
    };
    const rotated = {
      ...old,
      targetId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes,
    };
    await journalNativeOAuthGrant(
      initial.connectionId,
      intent.id,
      rotated,
      browserOAuthClassification,
    );
    return token;
  } finally {
    finishMutation();
  }
}
function refreshedPending(
  current: NativeConnectorRecord,
  old: NativeGrant,
  targetId: string,
  redirectUri: string,
): NativePending {
  const endpoints = browserOAuthEndpoints(
    requiredBrowserOAuthProfile(old.providerId),
    current.configuration,
  );
  return {
    providerId: old.providerId,
    actor: old.actor,
    fingerprint: old.fingerprint,
    targetId,
    issuer: endpoints.issuer,
    endpoint: endpoints.token,
    clientId: old.clientId,
    state: randomString(32),
    verifier: randomString(32),
    redirectUri,
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    scopes: browserOAuthScopes(
      requiredBrowserOAuthProfile(old.providerId),
      current.configuration,
      old.actor,
    ),
  };
}
async function markExpiredRefresh(id: string, intentId: string): Promise<void> {
  const record = requireNativeOAuthRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    browserOAuthClassification(record.configuration),
    (current) => {
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      current.privateState.verification = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
}
