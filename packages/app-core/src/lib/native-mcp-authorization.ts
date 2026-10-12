import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import { assertNativeBrowserMcpPolicy } from "./native-browser-policy.js";
import type {
  NativePending,
  NativeRecovery,
} from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { discardNativeConsent } from "./native-consent-cancel.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
import {
  MCP_CLASSIFICATION,
  nativeMcpClassification,
  nativeMcpRecordOAuthTarget,
} from "./native-mcp-profile.js";
import { prepareNativeMcpAuthorization } from "./native-mcp-reauthorize.js";
import {
  assertNativeMcpContract,
  nativeMcpClient,
  nativeMcpIssuedGrant,
  requireNativeMcpRecord,
} from "./native-mcp-records.js";
import { admitNativeMcpRegistration } from "./native-mcp-registration-admission.js";
import type { NativeMcpRegisteredClient } from "./native-mcp-registration-receipt.js";
import {
  assertNativeMcpRegistrationCapacity,
  releaseNativeMcpRegistrationReservation,
} from "./native-mcp-registration.js";
import { activateNativeMcpGrant } from "./native-mcp-verification.js";
import {
  type NativeOAuthBrowserPort,
  nativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";
import {
  claimNativeOAuthPending,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthCallbackTarget,
  nativeOAuthGuard,
} from "./native-oauth-session.js";

function oauth(
  id: string,
  transport: NativeProviderTransport,
  browser: NativeOAuthBrowserPort,
): NativeMcpPublicOAuth {
  return new NativeMcpPublicOAuth(
    nativeMcpRecordOAuthTarget(
      requireNativeMcpRecord(id).configuration,
      browser,
    ),
    { ...transport, signal: new AbortController().signal },
  );
}
function randomState(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type McpConsentContext = {
  id: string;
  actor: string;
  obligationId: string;
  client: NativeMcpRegisteredClient;
  target: NativeMcpOAuthTarget;
  protocol: NativeMcpPublicOAuth;
  transport: NativeProviderTransport;
  browser: NativeOAuthBrowserPort;
};
async function sealMcpConsent({
  id,
  actor,
  obligationId,
  client,
  target,
  protocol,
  transport,
  browser,
}: McpConsentContext): Promise<void> {
  const state = randomState();
  const consent = await protocol.consent(client, state);
  const current = requireNativeMcpRecord(id);
  const pending: NativePending = {
    providerId: target.binding.providerId,
    actor,
    fingerprint: target.binding.fingerprint,
    targetId: target.binding.resource,
    issuer: target.binding.issuer ?? undefined,
    resource: target.binding.resource,
    endpoint: target.binding.endpoint,
    clientId: client.client_id,
    state,
    verifier: consent.codeVerifier,
    redirectUri: target.redirectUri,
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60_000,
    scopes: [...target.scopes],
  };
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      transport.assertCurrent();
      record.privateState.pending[actor] = pending;
      record.privateState.recovery = record.privateState.recovery.filter(
        (entry) => entry.id !== obligationId,
      );
      return record;
    },
  );
  transport.assertCurrent();
  if (browser.authorize) {
    let callback: string;
    try {
      callback = await browser.authorize(consent.authorizationUrl.href, {
        state: pending.state,
        expiresAt: pending.expiresAt,
      });
    } catch (error) {
      await discardNativeConsent(id, pending.state, MCP_CLASSIFICATION);
      throw error;
    }
    await finishNativeMcpAuthorization(callback, transport);
  } else browser.navigate(consent.authorizationUrl.href);
}

/** Registration is a credential mutation: seal an obligation before sending it. */
export async function beginNativeMcpAuthorization(
  id: string,
  actor = "user",
  baseTransport: NativeProviderTransport = nativeProviderTransport(),
): Promise<void> {
  const transport = captureNativeAuthorizationTransport(baseTransport);
  transport.assertCurrent();
  assertNativeBrowserMcpPolicy(
    requireNativeMcpRecord(id).configuration.providerId,
  );
  if (actor !== "user") throw new NativeMcpAuthError("public-client");
  const browser = nativeOAuthBrowserPort();
  await prepareNativeMcpAuthorization(id, transport);
  const initial = requireNativeMcpRecord(id);
  await assertNativeMcpContract(initial);
  if (
    Object.keys(initial.privateState.pending).length ||
    initial.privateState.grants.user
  )
    throw new Error(
      "Finish existing provider authorization cleanup before starting consent",
    );
  const target = nativeMcpRecordOAuthTarget(initial.configuration, browser);
  const existing = initial.privateState.recovery[0];
  const obligation: NativeRecovery = existing ?? {
    id: `registration:${crypto.randomUUID()}`,
    kind: "registration",
    providerId: target.binding.providerId,
    actor,
    fingerprint: target.binding.fingerprint,
    targetId: target.binding.resource,
    issuer: target.binding.issuer ?? undefined,
    resource: target.binding.resource,
    endpoint: target.binding.endpoint,
    credentials: {
      phase: "registration",
      deadline: String(Date.now() + 60_000),
    },
  };
  if (!existing) {
    await updateNativeConnector(
      id,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (record) => {
        transport.assertCurrent();
        record.privateState.recovery.push(obligation);
        record.privateState.verification = null;
        return record;
      },
    );
  }
  assertNativeMcpRegistrationCapacity(id);
  const release = markNativeOAuthMutationInFlight(id, obligation.id);
  try {
    const protocol = oauth(id, transport, browser);
    const client = initial.privateState.credentials.mcp_client
      ? nativeMcpClient(initial)
      : await admitNativeMcpRegistration(id, obligation, target, transport);
    await sealMcpConsent({
      id,
      actor,
      obligationId: obligation.id,
      client,
      target,
      protocol,
      transport,
      browser,
    });
  } finally {
    releaseNativeMcpRegistrationReservation(id, obligation.id);
    release();
  }
}

/** Only the shared sealed-state claim chooses the connector/provider/actor. */
export async function finishNativeMcpAuthorization(
  search: string,
  baseTransport: NativeProviderTransport = nativeProviderTransport(),
) {
  const transport = captureNativeAuthorizationTransport(baseTransport);
  const browser = nativeOAuthBrowserPort();
  transport.assertCurrent();
  const callbackTarget = nativeOAuthCallbackTarget(search);
  if (callbackTarget?.method !== "mcp") throw new NativeMcpAuthError("pending");
  assertNativeBrowserMcpPolicy(callbackTarget.providerId);
  const { record, pending, obligation, code } = await claimNativeOAuthPending(
    search,
    MCP_CLASSIFICATION,
  );
  browser.scrubCallback();
  if (record.configuration.method !== "mcp")
    throw new NativeMcpAuthError("pending");
  await assertNativeMcpContract(record);
  const target = nativeMcpRecordOAuthTarget(record.configuration, browser);
  const client = nativeMcpClient(record);
  if (
    pending.actor !== "user" ||
    pending.resource !== target.binding.resource ||
    pending.issuer !== target.binding.issuer ||
    pending.endpoint !== target.binding.endpoint ||
    pending.clientId !== client.client_id ||
    pending.redirectUri !== target.redirectUri
  )
    throw new NativeMcpAuthError("pending");
  const release = markNativeOAuthMutationInFlight(
    record.connectionId,
    obligation.id,
  );
  try {
    const tokens = await oauth(
      record.connectionId,
      transport,
      browser,
    ).exchange(client, code, pending.verifier);
    const grant = nativeMcpIssuedGrant(pending, tokens);
    await journalNativeOAuthGrant(
      record.connectionId,
      obligation.id,
      grant,
      nativeMcpClassification,
    );
    transport.assertCurrent();
    if (!tokens.protocolValid) throw new NativeMcpAuthError("authorization");
    return activateNativeMcpGrant(
      record.connectionId,
      obligation.id,
      grant,
      transport,
    );
  } finally {
    release();
  }
}
