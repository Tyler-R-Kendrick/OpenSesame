import type { NativeGrant } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  MCP_CLASSIFICATION,
  nativeMcpRecordBinding,
} from "./native-mcp-profile.js";
import { NativeMcpSession } from "./native-mcp-protocol.js";
import {
  assertNativeMcpContract,
  requireNativeMcpRecord,
} from "./native-mcp-records.js";
import { NativeMcpError } from "./native-mcp-target.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

export async function markNativeMcpRefused(
  record: NativeConnectorRecord,
): Promise<void> {
  await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    MCP_CLASSIFICATION,
    (current) => {
      current.privateState.verification = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
}
export async function nativeMcpRecordSession(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
  issuedGrant?: NativeGrant,
): Promise<NativeMcpSession> {
  await assertNativeMcpContract(record);
  await assertNativeConnectorRevision(
    record.connectionId,
    nativeOAuthGuard(record),
  );
  const binding = nativeMcpRecordBinding(record.configuration);
  const grant = issuedGrant ?? record.privateState.grants.user;
  if (grant && grant.expiresAt !== null && grant.expiresAt <= Date.now())
    throw new NativeMcpError("authorization");
  const assertCurrent = () => {
    transport.assertCurrent();
    const actual = requireNativeMcpRecord(record.connectionId);
    if (
      actual.revision !== record.revision ||
      actual.configuration.fingerprint !== binding.fingerprint
    )
      throw new NativeMcpError("disposed");
  };
  assertCurrent();
  return new NativeMcpSession(binding, {
    fetch: transport.fetch,
    assertCurrent,
    accessGrant: async () =>
      grant
        ? {
            token: grant.accessToken,
            providerId: grant.providerId,
            fingerprint: grant.fingerprint,
            issuer: grant.issuer ?? null,
            resource: grant.resource ?? "",
          }
        : null,
    authorizationRequired: () => markNativeMcpRefused(record),
  });
}
