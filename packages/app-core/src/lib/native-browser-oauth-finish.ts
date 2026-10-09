import { verifyNativeBrowserCimd } from "./native-browser-oauth-cimd.js";
import { cleanupNativeBrowserOAuth } from "./native-browser-oauth-cleanup.js";
/** Issued credentials are retained before verification or capability freshness checks. */
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import {
  type IssuedNativeOAuthToken,
  exchangeNativeBrowserCode,
} from "./native-browser-oauth-token.js";
import { verifyNativeBrowserOAuth } from "./native-browser-oauth-verify.js";
import { assertNativeBrowserOAuthPolicy } from "./native-browser-policy.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import type { NativeGrant, NativePending } from "./native-connector-schema.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { commitNativeOAuthGrant } from "./native-oauth-commit.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  claimNativeOAuthPending,
  findNativeOAuthPending,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  parseNativeOAuthCallback,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";

function issuedGrant(
  pending: NativePending,
  token: IssuedNativeOAuthToken,
): NativeGrant {
  return {
    kind: "oauth",
    providerId: pending.providerId,
    actor: pending.actor,
    fingerprint: pending.fingerprint,
    targetId: pending.targetId ?? pending.providerId,
    issuer: pending.issuer,
    endpoint: pending.endpoint,
    clientId: pending.clientId,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    scopes: token.scopes,
    expiresAt: token.expiresAt,
  };
}
async function compensateUnsealed(
  id: string,
  intentId: string,
  grant: NativeGrant,
  transport: NativeProviderTransport,
): Promise<never> {
  const record = requireNativeOAuthRecord(id);
  try {
    await cleanupNativeBrowserOAuth(
      {
        id: intentId,
        kind: "configure",
        providerId: grant.providerId,
        actor: grant.actor,
        fingerprint: grant.fingerprint,
        targetId: grant.targetId ?? grant.providerId,
        grant,
      },
      {
        connectionId: id,
        configuration: record.configuration,
        persistGrantRotation: async () => {
          throw new NativeOAuthError("storage");
        },
      },
      transport,
    );
  } catch {
    throw new NativeOAuthError("cleanup");
  }
  throw new NativeOAuthError("storage");
}
export async function retainAndVerifyNativeBrowserToken(
  id: string,
  intentId: string,
  pending: NativePending,
  token: IssuedNativeOAuthToken,
  transport: NativeProviderTransport,
) {
  const grant = issuedGrant(pending, token);
  try {
    await journalNativeOAuthGrant(
      id,
      intentId,
      grant,
      browserOAuthClassification,
      {
        id_token: token.idToken ?? "",
        nonce: pending.state,
        requested_scopes: JSON.stringify(pending.scopes),
        protocol_valid: String(token.protocolValid),
      },
    );
  } catch {
    return compensateUnsealed(id, intentId, grant, transport);
  }
  try {
    transport.assertCurrent();
    const record = requireNativeOAuthRecord(id);
    const retained = record.privateState.recovery.find(
      (entry) => entry.id === intentId,
    )?.grant;
    if (!retained) throw new NativeOAuthError("storage");
    if (record.configuration.fingerprint !== pending.fingerprint)
      throw new NativeOAuthError("expired");
    const verification = await verifyNativeBrowserOAuth(
      record.configuration,
      pending,
      token,
      transport,
    );
    const view = await commitNativeOAuthGrant(
      id,
      intentId,
      verification,
      browserOAuthClassification,
      transport,
      { revision: record.revision, grant: retained },
    );
    if (view.recovery.length) return retryNativeConnectorCleanup(id);
    return view;
  } catch (error) {
    try {
      transport.assertCurrent();
    } catch {
      throw error;
    }
    await retryNativeConnectorCleanup(id).catch(() => undefined);
    throw error;
  }
}
export async function finishNativeBrowserAuthorization(search: string) {
  const browser = nativeOAuthBrowserPort();
  try {
    const callback = parseNativeOAuthCallback(search);
    browser.scrubCallback();
    const found = findNativeOAuthPending(callback.state);
    if (!found || found.record.configuration.method !== "oauth")
      throw new NativeOAuthError("callback");
    assertNativeBrowserOAuthPolicy(found.record.configuration.providerId);
    const transport = nativeProviderTransport();
    await verifyNativeBrowserCimd(
      found.record.configuration,
      found.pending.redirectUri,
      transport,
    );
    const claim = await claimNativeOAuthPending(
      search,
      browserOAuthClassification(found.record.configuration),
    );
    const finishMutation = markNativeOAuthMutationInFlight(
      claim.record.connectionId,
      claim.obligation.id,
    );
    try {
      const token = await exchangeNativeBrowserCode(
        claim.record.configuration,
        claim.pending,
        claim.code,
        transport,
      );
      return await retainAndVerifyNativeBrowserToken(
        claim.record.connectionId,
        claim.obligation.id,
        claim.pending,
        token,
        transport,
      );
    } finally {
      finishMutation();
    }
  } finally {
    browser.scrubCallback();
  }
}
