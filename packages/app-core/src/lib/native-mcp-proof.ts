/** Protocol and grant proofs shared by initial authorization and refresh without a cycle. */
import { canonicalize } from "@opensesame/os-domain";
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
import { requireNativeMcpRecord } from "./native-mcp-records.js";
import { nativeMcpRecordSession } from "./native-mcp-session.js";
import { NativeMcpError } from "./native-mcp-target.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

function verified(
  record: NativeConnectorRecord,
  grant?: NativeGrant,
): NativeConnectorRecord {
  const verifiedAt = Math.max(Date.now(), (record.runtime.verifiedAt ?? 0) + 1);
  const binding = nativeMcpRecordBinding(record.configuration);
  if (
    grant?.scopes &&
    (record.configuration.requestedScopes.user ?? []).some(
      (scope) => !grant.scopes?.includes(scope),
    )
  )
    throw new NativeMcpError("permission");
  record.privateState.grants = grant ? { user: grant } : {};
  record.privateState.verification = {
    fingerprint: binding.fingerprint,
    verifiedAt,
    kind: "provider",
  };
  record.runtime = {
    verifiedAt,
    identity: null,
    targets: [
      { id: binding.resource, label: binding.resource, kind: "mcp-resource" },
    ],
    grants: grant
      ? [
          {
            actor: "user",
            label: "MCP authorization",
            permissionState:
              grant.scopes === null ? "provider-managed" : "known",
            grantedScopes: grant.scopes ?? [],
            expiresAt: grant.expiresAt,
            needsReauth: false,
          },
        ]
      : [],
  };
  return record;
}
async function protocolProof(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
  grant?: NativeGrant,
): Promise<void> {
  const session = await nativeMcpRecordSession(record, transport, grant);
  try {
    await session.connect();
  } finally {
    await session.dispose();
  }
  await assertNativeConnectorRevision(
    record.connectionId,
    nativeOAuthGuard(record),
  );
  transport.assertCurrent();
}
export async function activateNativeMcpGrant(
  id: string,
  obligationId: string,
  grant: NativeGrant,
  transport: NativeProviderTransport,
) {
  const record = requireNativeMcpRecord(id);
  const intent = record.privateState.recovery.find(
    (entry) => entry.id === obligationId,
  );
  if (!intent?.grant || canonicalize(intent.grant) !== canonicalize(grant))
    throw new NativeMcpError("authorization");
  await protocolProof(record, transport, grant);
  return updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    MCP_CLASSIFICATION,
    (current) => {
      transport.assertCurrent();
      const expected = current.privateState.recovery.find(
        (entry) => entry.id === obligationId,
      );
      if (
        !expected?.grant ||
        canonicalize(expected.grant) !== canonicalize(grant)
      )
        throw new NativeMcpError("authorization");
      current.privateState.recovery = current.privateState.recovery.filter(
        (entry) => entry.id !== obligationId,
      );
      return verified(current, grant);
    },
    transport.assertCurrent,
  );
}

export async function verifyNativeMcpRecord(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  await protocolProof(record, transport);
  return updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    MCP_CLASSIFICATION,
    (current) => {
      transport.assertCurrent();
      return verified(current, current.privateState.grants.user);
    },
    transport.assertCurrent,
  );
}
