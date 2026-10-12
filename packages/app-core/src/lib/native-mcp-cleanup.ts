import type {
  NativeCleanupContext,
  NativeProviderCleanup,
} from "./native-connector-lifecycle.js";
import type { NativeRecovery } from "./native-connector-schema.js";
import { updateNativeConnector } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
import {
  MCP_CLASSIFICATION,
  nativeMcpClassification,
  nativeMcpRecordOAuthTarget,
} from "./native-mcp-profile.js";
import {
  nativeMcpClient,
  requireNativeMcpRecord,
} from "./native-mcp-records.js";
import { retryRetainedNativeMcpRegistration } from "./native-mcp-registration.js";
import {
  nativeOAuthGuard,
  retryRetainedNativeOAuthGrants,
} from "./native-oauth-session.js";

import { deleteNativeMcpRegistration } from "./native-mcp-registration-cleanup.js";

import { NativeMcpRegistrationReceiptSchema } from "./native-mcp-registration-receipt.js";

export async function prepareNativeMcpCleanup(id: string): Promise<void> {
  await retryRetainedNativeOAuthGrants(id);
  await retryRetainedNativeMcpRegistration(id);
  const current = requireNativeMcpRecord(id);
  if (
    !current.privateState.recovery.some(
      (entry) =>
        entry.kind === "configure" &&
        entry.credentials?.phase === "verify" &&
        entry.grant?.kind === "mcp",
    )
  )
    return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      record.privateState.recovery = record.privateState.recovery.map(
        (entry) =>
          entry.kind === "configure" &&
          entry.credentials?.phase === "verify" &&
          entry.grant?.kind === "mcp"
            ? { ...entry, kind: "revoke" }
            : entry,
      );
      return record;
    },
  );
}
async function removeRegistration(
  context: NativeCleanupContext,
  target: Parameters<typeof deleteNativeMcpRegistration>[0],
  client: Parameters<typeof deleteNativeMcpRegistration>[1],
  transport: Parameters<typeof deleteNativeMcpRegistration>[2],
): Promise<boolean> {
  const removed = await deleteNativeMcpRegistration(target, client, transport);
  if (!removed) return false;
  const current = requireNativeMcpRecord(context.connectionId);
  await updateNativeConnector(
    context.connectionId,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      const { mcp_client: _removedClient, ...credentials } =
        record.privateState.credentials;
      record.privateState.credentials = credentials;
      return record;
    },
  );
  return true;
}

function cleanupGrant(
  obligation: NativeRecovery,
  target: ReturnType<typeof nativeMcpRecordOAuthTarget>,
  client: ReturnType<typeof nativeMcpClient>,
) {
  if (
    obligation.kind !== "revoke" ||
    !obligation.grant ||
    obligation.grant.kind !== "mcp"
  )
    throw new Error(
      "Unresolved MCP credential issuance requires provider recovery before removal",
    );
  const grant = obligation.grant;
  if (
    grant.issuer !== target.binding.issuer ||
    grant.resource !== target.binding.resource ||
    grant.endpoint !== target.binding.endpoint ||
    grant.clientId !== client.client_id
  )
    throw new NativeMcpAuthError("pending");
  return grant;
}

async function cleanup(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const record = requireNativeMcpRecord(context.connectionId);
  const target = nativeMcpRecordOAuthTarget(record.configuration);
  transport.assertCurrent();
  const receipt =
    obligation.credentials?.client ?? obligation.credentials?.mcp_client;
  const client = receipt
    ? NativeMcpRegistrationReceiptSchema.parse(JSON.parse(receipt))
    : nativeMcpClient(record);
  if (obligation.kind === "registration") {
    if (
      obligation.credentials?.phase !== "registered" ||
      !(await removeRegistration(context, target, client, transport))
    )
      throw new Error(
        "This MCP provider does not offer registration deletion; finish the retained registration authorization or remove it in provider settings",
      );
    return "provider-revoked" as const;
  }
  const grant = cleanupGrant(obligation, target, client);
  if (!target.metadata.revocationEndpoint) {
    if (await removeRegistration(context, target, client, transport))
      return "provider-revoked" as const;
    return "local-credential-forgotten" as const;
  }
  const protocol = new NativeMcpPublicOAuth(target, {
    ...transport,
    signal: new AbortController().signal,
  });
  if (grant.refreshToken)
    await protocol.revoke(client, grant.refreshToken, "refresh_token");
  await protocol.revoke(client, grant.accessToken, "access_token");
  await removeRegistration(context, target, client, transport);
  return "provider-revoked" as const;
}
export const nativeMcpCleanup: NativeProviderCleanup = {
  classification: nativeMcpClassification,
  credentialSlots: ["mcp_client"],
  prepare: prepareNativeMcpCleanup,
  cleanup,
};

export function createNativeMcpCleanup(
  transport: NativeProviderTransport,
): NativeProviderCleanup {
  return {
    ...nativeMcpCleanup,
    prepare: async (id) => {
      transport.assertCurrent();
      await prepareNativeMcpCleanup(id);
      transport.assertCurrent();
    },
    cleanup: (obligation, context) => cleanup(obligation, context, transport),
  };
}
