import { assertNativeBrowserMcpPolicy } from "./native-browser-policy.js";
import type { NativeRecovery } from "./native-connector-schema.js";
/** Journal the old pair before refresh, then seal its replacement before verification. */
import type { NativeConnectorRecord } from "./native-connector-store.js";
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { withNativeMcpMutationLock } from "./native-mcp-mutation-lock.js";
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
import { markNativeMcpSubmitting } from "./native-mcp-submission.js";

import {
  MCP_CLASSIFICATION,
  nativeMcpClassification,
  nativeMcpRecordOAuthTarget,
} from "./native-mcp-profile.js";
import { activateNativeMcpGrant } from "./native-mcp-proof.js";
import {
  nativeMcpClient,
  nativeMcpIssuedGrant,
  requireNativeMcpRecord,
} from "./native-mcp-records.js";
import {
  journalNativeOAuthGrant,
  markNativeOAuthMutationInFlight,
  nativeOAuthGuard,
} from "./native-oauth-session.js";

function refreshProtocol(
  initial: NativeConnectorRecord,
  intent: NativeRecovery,
  transport: NativeProviderTransport,
  target: ReturnType<typeof nativeMcpRecordOAuthTarget>,
  onSubmit: () => Promise<void>,
): NativeMcpPublicOAuth {
  const track =
    (send: typeof fetch): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      if (
        request.method === "POST" &&
        request.url === target.metadata.tokenEndpoint
      )
        await onSubmit();
      return send(request);
    };
  const ports: NativeMcpOAuthPorts = {
    ...transport,
    retainPartialRefresh: (token) =>
      retainNativeMcpPartialRefresh(initial.connectionId, intent.id, token),
    fetch: track(transport.fetch),
    signal: new AbortController().signal,
  };
  if (transport.settleCredentialMutation)
    ports.settleCredentialMutation = track(transport.settleCredentialMutation);
  return new NativeMcpPublicOAuth(target, ports);
}

async function recoverFailedRefresh(
  id: string,
  intentId: string,
  invalidGrant: boolean,
  received: boolean,
  submitted: boolean,
): Promise<void> {
  if (!received && invalidGrant) await markInvalidRefresh(id, intentId);
  else if (!received && !submitted) await clearRefreshIntent(id, intentId);
}

function refreshIntent(
  old: NonNullable<NativeConnectorRecord["privateState"]["grants"][string]>,
  targetId: string,
): NativeRecovery {
  return {
    id: `mcp-refresh:${crypto.randomUUID()}`,
    kind: "configure",
    providerId: old.providerId,
    actor: old.actor,
    fingerprint: old.fingerprint,
    targetId,
    grant: { ...old, targetId },
    credentials: {
      phase: "refresh",
      submission: "prepared",
      deadline: String(Date.now() + 60_000),
    },
  };
}
export async function refreshNativeMcpAuthorization(
  initial: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  return withNativeMcpMutationLock(initial.connectionId, async () => {
    transport.assertCurrent();
    assertNativeBrowserMcpPolicy(initial.configuration.providerId);
    const old = initial.privateState.grants.user;
    if (
      !old?.refreshToken ||
      initial.privateState.recovery.length ||
      Object.keys(initial.privateState.pending).length
    )
      throw new NativeMcpAuthError("authorization");
    const target = nativeMcpRecordOAuthTarget(initial.configuration);
    const targetId = target.binding.resource;
    const intent = refreshIntent(old, targetId);
    await updateNativeConnector(
      initial.connectionId,
      nativeOAuthGuard(initial),
      MCP_CLASSIFICATION,
      (record) => {
        transport.assertCurrent();
        record.privateState.recovery.push(intent);
        record.privateState.verification = null;
        return record;
      },
    );
    const release = markNativeOAuthMutationInFlight(
      initial.connectionId,
      intent.id,
    );
    let received = false;
    let submitted = false;
    try {
      reserveNativeMcpPartialRefresh(
        initial.connectionId,
        intent.id,
        intent.fingerprint,
      );
      const protocol = refreshProtocol(
        initial,
        intent,
        transport,
        target,
        async () => {
          await markNativeMcpSubmitting(initial.connectionId, intent.id);
          submitted = true;
        },
      );
      const tokens = await protocol.refresh(
        nativeMcpClient(initial),
        old.refreshToken,
      );
      received = true;
      const grant = nativeMcpIssuedGrant({ ...old, targetId }, tokens);
      grant.refreshToken = grant.refreshToken ?? old.refreshToken;
      if (tokens.protocolValid) grant.scopes = grant.scopes ?? old.scopes;
      await journalNativeOAuthGrant(
        initial.connectionId,
        intent.id,
        grant,
        nativeMcpClassification,
      );
      transport.assertCurrent();
      if (!tokens.protocolValid) throw new NativeMcpAuthError("authorization");
      return await activateNativeMcpGrant(
        initial.connectionId,
        intent.id,
        grant,
        transport,
      );
    } catch (error) {
      // Once a token response is captured, retain its recovery obligation.
      // If sealing failed, the in-memory journal can retry against that intent;
      // if verification failed, the sealed replacement can be revoked. A lost
      // response after submission is indeterminate and also needs cleanup.
      await recoverFailedRefresh(
        initial.connectionId,
        intent.id,
        error instanceof NativeMcpAuthError &&
          error.oauthError === "invalid_grant",
        received,
        submitted,
      );
      throw error;
    } finally {
      releaseNativeMcpPartialReservation(initial.connectionId, intent.id);
      release();
    }
  });
}
async function clearRefreshIntent(id: string, intentId: string): Promise<void> {
  const record = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    MCP_CLASSIFICATION,
    (current) => {
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== intentId,
      );
      current.privateState.verification = null;
      return current;
    },
  );
}

async function markInvalidRefresh(id: string, intentId: string): Promise<void> {
  const record = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    MCP_CLASSIFICATION,
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
