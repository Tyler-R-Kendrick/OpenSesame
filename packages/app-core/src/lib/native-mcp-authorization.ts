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
import { withNativeMcpMutationLock } from "./native-mcp-mutation-lock.js";
import type { NativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import {
  type NativeMcpOAuthPorts,
  NativeMcpPublicOAuth,
} from "./native-mcp-oauth.js";
import {
  releaseNativeMcpPartialReservation,
  reserveNativeMcpPartialRefresh,
  retainNativeMcpPartialRefresh,
} from "./native-mcp-partial-refresh.js";
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
  assertNativeMcpRegistrationAvailable,
  releaseNativeMcpRegistrationReservation,
} from "./native-mcp-registration.js";
import {
  discardUnsubmittedExchange,
  markNativeMcpSubmitting,
  trackExchange,
} from "./native-mcp-submission.js";
import { activateNativeMcpGrant } from "./native-mcp-verification.js";
import {
  type NativeOAuthBrowserPort,
  nativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";
import {
  claimNativeOAuthPending,
  findNativeOAuthPending,
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthCallbackTarget,
  nativeOAuthGuard,
  nativeOAuthObligation,
  parseNativeOAuthCallback,
} from "./native-oauth-session.js";

function oauth(
  id: string,
  transport: NativeProviderTransport,
  browser: NativeOAuthBrowserPort,
  retainPartialRefresh?: (token: string) => Promise<void>,
): NativeMcpPublicOAuth {
  const ports: NativeMcpOAuthPorts = {
    ...transport,
    signal: new AbortController().signal,
  };
  if (retainPartialRefresh) ports.retainPartialRefresh = retainPartialRefresh;
  return new NativeMcpPublicOAuth(
    nativeMcpRecordOAuthTarget(
      requireNativeMcpRecord(id).configuration,
      browser,
    ),
    ports,
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
}: McpConsentContext) {
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
  return {
    url: consent.authorizationUrl.href,
    state: pending.state,
    expiresAt: pending.expiresAt,
  };
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
  const consent = await withNativeMcpMutationLock(id, async () => {
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
      credentials: initial.privateState.credentials.mcp_client
        ? {
            phase: "registered",
            client: initial.privateState.credentials.mcp_client,
            registration_mode: "unknown",
          }
        : {
            phase: "registration",
            submission: "prepared",
            deadline: String(Date.now() + 60_000),
          },
    };
    assertNativeMcpRegistrationAvailable(id);
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
    const release = markNativeOAuthMutationInFlight(id, obligation.id);
    try {
      const protocol = oauth(id, transport, browser);
      const client = initial.privateState.credentials.mcp_client
        ? nativeMcpClient(initial)
        : await admitNativeMcpRegistration(id, obligation, target, transport);
      return await sealMcpConsent({
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
  });
  if (browser.authorize) {
    let callback: string;
    try {
      callback = await browser.authorize(consent.url, {
        state: consent.state,
        expiresAt: consent.expiresAt,
      });
    } catch (error) {
      await discardNativeConsent(id, consent.state, MCP_CLASSIFICATION);
      throw error;
    }
    await finishNativeMcpAuthorization(callback, transport);
  } else browser.navigate(consent.url);
}

async function validateMcpClaim(
  claim: Awaited<ReturnType<typeof claimNativeOAuthPending>>,
  preview: NonNullable<ReturnType<typeof findNativeOAuthPending>>,
  reservationId: string,
  browser: NativeOAuthBrowserPort,
) {
  const { record, pending, obligation } = claim;
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
    pending.redirectUri !== target.redirectUri ||
    record.connectionId !== preview.record.connectionId ||
    pending.fingerprint !== preview.pending.fingerprint ||
    obligation.id !== reservationId
  )
    throw new NativeMcpAuthError("pending");
  return client;
}

function claimPrepared(search: string) {
  return claimNativeOAuthPending(search, MCP_CLASSIFICATION, (obligation) => {
    obligation.credentials = {
      ...obligation.credentials,
      submission: "prepared",
    };
  });
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
  const preview = findNativeOAuthPending(
    parseNativeOAuthCallback(search).state,
  );
  if (!preview || preview.record.connectionId !== callbackTarget.connectionId)
    throw new NativeMcpAuthError("pending");
  return withNativeMcpMutationLock(preview.record.connectionId, async () => {
    const reservationId = nativeOAuthObligation(preview.pending).id;
    reserveNativeMcpPartialRefresh(
      preview.record.connectionId,
      reservationId,
      preview.pending.fingerprint,
    );
    let submitted = false;
    let claimed = false;
    try {
      const claim = await claimPrepared(search);
      claimed = true;
      browser.scrubCallback();
      const client = await validateMcpClaim(
        claim,
        preview,
        reservationId,
        browser,
      );
      const { record, pending, obligation, code } = claim;
      const release = markNativeOAuthMutationInFlight(
        record.connectionId,
        obligation.id,
      );
      try {
        const tokens = await oauth(
          record.connectionId,
          trackExchange(
            transport,
            nativeMcpRecordOAuthTarget(record.configuration, browser).metadata
              .tokenEndpoint,
            async () => {
              await markNativeMcpSubmitting(record.connectionId, obligation.id);
              submitted = true;
            },
          ),
          browser,
          (token) =>
            retainNativeMcpPartialRefresh(
              record.connectionId,
              obligation.id,
              token,
            ),
        ).exchange(client, code, pending.verifier);
        const grant = nativeMcpIssuedGrant(pending, tokens);
        await journalNativeOAuthGrant(
          record.connectionId,
          obligation.id,
          grant,
          nativeMcpClassification,
        );
        transport.assertCurrent();
        if (!tokens.protocolValid)
          throw new NativeMcpAuthError("authorization");
        return activateNativeMcpGrant(
          record.connectionId,
          obligation.id,
          grant,
          transport,
        );
      } finally {
        release();
      }
    } catch (error) {
      if (claimed && !submitted)
        await discardUnsubmittedExchange(
          preview.record.connectionId,
          reservationId,
        );
      throw error;
    } finally {
      releaseNativeMcpPartialReservation(
        preview.record.connectionId,
        reservationId,
      );
    }
  });
}
