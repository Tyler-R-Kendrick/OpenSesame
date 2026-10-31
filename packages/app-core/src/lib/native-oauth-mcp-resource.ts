/** MCP consumes a real configured OAuth grant; its protocol is not the authentication method. */
import { canonicalize } from "@opensesame/os-domain";
import { subscribeDeviceRows } from "./device-connector-records.js";
import type { NativeGrant } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  type NativeMcpDiscovery,
  NativeMcpSession,
  type NativeMcpToolResult,
} from "./native-mcp-protocol.js";
import { type NativeMcpBinding, NativeMcpError } from "./native-mcp-target.js";
import {
  type NativeOAuthClientOwner,
  assertNativeOAuthClientOwner,
  assertNativeOAuthClientPolicy,
  nativeOAuthClientClassification,
  nativeOAuthClientTarget,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { admissibleGrantScopes } from "./native-oauth-client-scopes.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import { vaultStore } from "./vault/store.js";
function actualGrant(
  id: string,
  grant: NativeGrant,
  owner: NativeOAuthClientOwner,
) {
  const record = requireNativeOAuthRecord(id);
  const target = nativeOAuthClientTarget(record.configuration);
  assertNativeOAuthClientOwner(owner);
  readNativeOAuthClientSecret(id, owner);
  if (
    !target.resource ||
    grant.kind !== "oauth" ||
    grant.providerId !== record.configuration.providerId ||
    grant.fingerprint !== record.configuration.fingerprint ||
    grant.resource !== target.resource ||
    grant.issuer !== target.issuer ||
    grant.endpoint !== target.token_endpoint ||
    grant.clientId !== target.clientId ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now())
  )
    throw new NativeOAuthError("expired");
  if (
    !admissibleGrantScopes(
      record.configuration.providerId,
      record.configuration.requestedScopes[grant.actor] ?? [],
      grant.scopes,
    )
  )
    throw new NativeOAuthError("scope");
  const saved = [
    record.privateState.grants.user,
    ...record.privateState.recovery
      .filter(
        (intent) =>
          intent.credentials?.phase === "verify" &&
          intent.credentials?.protocol_valid === "true",
      )
      .map((intent) => intent.grant),
  ];
  if (
    !saved.some(
      (candidate) =>
        candidate && canonicalize(candidate) === canonicalize(grant),
    )
  )
    throw new NativeOAuthError("expired");
  assertNativeOAuthClientPolicy(record.configuration, owner);
  return { record, target };
}
function resultPrivacy(
  check: () => void,
  secrets: readonly (string | undefined)[],
) {
  return (value: NativeMcpDiscovery | NativeMcpToolResult) => {
    check();
    const encoded = JSON.stringify(value);
    if (
      secrets.some(
        (secret) =>
          secret && encoded.includes(JSON.stringify(secret).slice(1, -1)),
      )
    )
      throw new NativeMcpError("response");
  };
}
function refusal(record: NativeConnectorRecord, check: () => void) {
  return async () => {
    check();
    await updateNativeConnector(
      record.connectionId,
      nativeOAuthGuard(record),
      nativeOAuthClientClassification(),
      (current) => {
        check();
        current.privateState.verification = null;
        current.runtime.verifiedAt = null;
        current.runtime.grants = current.runtime.grants.map((item) => ({
          ...item,
          needsReauth: true,
        }));
        return current;
      },
      check,
    );
  };
}
export function nativeOAuthMcpResource(
  id: string,
  suppliedGrant: NativeGrant,
  suppliedOwner: NativeOAuthClientOwner,
  signal?: AbortSignal,
) {
  const grant = structuredClone(suppliedGrant);
  const owner = Object.freeze({ ...suppliedOwner });
  const { record, target } = actualGrant(id, grant, owner);
  const lifetime = new AbortController();
  const originalSignal = owner.transport.signal;
  if (!originalSignal) throw new NativeOAuthError("expired");
  const signals = [lifetime.signal, originalSignal];
  if (signal) signals.push(signal);
  const captured = AbortSignal.any(signals);
  const check = () => {
    captured.throwIfAborted();
    assertNativeOAuthClientOwner(owner);
    readNativeOAuthClientSecret(id, owner);
    assertNativeOAuthClientPolicy(record.configuration, owner);
    const current = requireNativeOAuthRecord(id);
    if (
      current.revision !== record.revision ||
      current.configuration.fingerprint !== record.configuration.fingerprint
    )
      throw new NativeOAuthError("expired");
  };
  const transport: NativeProviderTransport = {
    assertCurrent: check,
    signal: captured,
    fetch: (input, init) => {
      check();
      const request = new Request(input, init);
      return owner.transport.fetch(request, {
        signal: AbortSignal.any([captured, request.signal]),
      });
    },
  };
  const stopLock = vaultStore.onLock(() => lifetime.abort());
  const stopRows = subscribeDeviceRows(() => {
    try {
      check();
    } catch {
      lifetime.abort();
    }
  });
  const binding: NativeMcpBinding = {
    providerId: record.configuration.providerId,
    fingerprint: grant.fingerprint,
    endpoint: target.mcp_endpoint ?? target.resource ?? "",
    resource: target.resource ?? "",
    issuer: target.issuer,
    transport: target.mcp_transport ?? "streamable-http",
    ssePostEndpoint: target.mcp_post_endpoint,
  };
  const session = new NativeMcpSession(binding, {
    fetch: transport.fetch,
    assertCurrent: check,
    accessGrant: async () => ({
      token: grant.accessToken,
      providerId: grant.providerId,
      fingerprint: grant.fingerprint,
      issuer: grant.issuer ?? null,
      resource: grant.resource ?? "",
    }),
    authorizationRequired: refusal(record, check),
  });
  const privateResult = resultPrivacy(check, [
    grant.accessToken,
    grant.refreshToken,
    readNativeOAuthClientSecret(id, owner),
  ]);
  return {
    record,
    binding,
    session,
    transport,
    check,
    privateResult,
    async dispose() {
      lifetime.abort();
      stopRows();
      stopLock();
      await session.dispose();
    },
  };
}
