import { assertNativeBrowserMcpPolicy } from "./native-browser-policy.js";
import type { NativeRecovery } from "./native-connector-schema.js";
/** Journal the old pair before refresh, then seal its replacement before verification. */
import type { NativeConnectorRecord } from "./native-connector-store.js";
import { updateNativeConnector } from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
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

export async function refreshNativeMcpAuthorization(
  initial: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
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
  const intent: NativeRecovery = {
    id: `mcp-refresh:${crypto.randomUUID()}`,
    kind: "configure",
    providerId: old.providerId,
    actor: old.actor,
    fingerprint: old.fingerprint,
    targetId,
    grant: { ...old, targetId },
    credentials: { phase: "refresh", deadline: String(Date.now() + 60_000) },
  };
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
  try {
    const protocol = new NativeMcpPublicOAuth(target, {
      ...transport,
      signal: new AbortController().signal,
    });
    let tokens: Awaited<ReturnType<NativeMcpPublicOAuth["refresh"]>>;
    try {
      tokens = await protocol.refresh(
        nativeMcpClient(initial),
        old.refreshToken,
      );
    } catch (error) {
      if (
        error instanceof NativeMcpAuthError &&
        error.oauthError === "invalid_grant"
      )
        await markInvalidRefresh(initial.connectionId, intent.id);
      throw error;
    }
    const grant = nativeMcpIssuedGrant({ ...old, targetId }, tokens);
    grant.refreshToken = grant.refreshToken ?? old.refreshToken;
    grant.scopes = grant.scopes ?? old.scopes;
    await journalNativeOAuthGrant(
      initial.connectionId,
      intent.id,
      grant,
      nativeMcpClassification,
    );
    transport.assertCurrent();
    if (!tokens.protocolValid) throw new NativeMcpAuthError("authorization");
    return activateNativeMcpGrant(
      initial.connectionId,
      intent.id,
      grant,
      transport,
    );
  } finally {
    release();
  }
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
