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
import { withNativeMcpMutationLock } from "./native-mcp-mutation-lock.js";
import { NativeMcpAuthError } from "./native-mcp-oauth-target.js";
import { NativeMcpPublicOAuth } from "./native-mcp-oauth.js";
import { retryRetainedNativeMcpPartialRefresh } from "./native-mcp-partial-refresh.js";
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

function needsCleanup(entry: NativeRecovery): boolean {
  if (entry.kind !== "configure") return false;
  if (entry.credentials?.phase === "partial-refresh") return true;
  return entry.credentials?.phase === "verify" && entry.grant?.kind === "mcp";
}
async function clearPreparedIntents(id: string): Promise<void> {
  const before = requireNativeMcpRecord(id);
  if (
    !before.privateState.recovery.some(
      (entry) => entry.credentials?.submission === "prepared",
    )
  )
    return;
  await withNativeMcpMutationLock(id, async () => {
    const current = requireNativeMcpRecord(id);
    await updateNativeConnector(
      id,
      nativeOAuthGuard(current),
      MCP_CLASSIFICATION,
      (record) => {
        record.privateState.recovery = record.privateState.recovery.filter(
          (entry) => entry.credentials?.submission !== "prepared",
        );
        return record;
      },
    );
  });
}
async function retainOrphanRegistration(id: string): Promise<void> {
  const initial = requireNativeMcpRecord(id);
  const privateState = initial.privateState;
  if (
    !privateState.credentials.mcp_client ||
    privateState.recovery.some((entry) => entry.kind === "registration") ||
    Object.keys(privateState.pending).length ||
    Object.keys(privateState.grants).length
  )
    return;
  await withNativeMcpMutationLock(id, async () => {
    const current = requireNativeMcpRecord(id);
    const target = nativeMcpRecordOAuthTarget(current.configuration);
    await updateNativeConnector(
      id,
      nativeOAuthGuard(current),
      MCP_CLASSIFICATION,
      (record) => {
        const client = record.privateState.credentials.mcp_client;
        if (
          !client ||
          record.privateState.recovery.some(
            (entry) => entry.kind === "registration",
          ) ||
          Object.keys(record.privateState.pending).length ||
          Object.keys(record.privateState.grants).length
        )
          throw new NativeMcpAuthError("pending");
        record.privateState.recovery.push({
          id: `registration-recovery:${crypto.randomUUID()}`,
          kind: "registration",
          providerId: target.binding.providerId,
          actor: "user",
          fingerprint: target.binding.fingerprint,
          targetId: target.binding.resource,
          issuer: target.binding.issuer ?? undefined,
          resource: target.binding.resource,
          endpoint: target.binding.endpoint,
          credentials: {
            phase: "registered",
            client,
            registration_mode:
              record.privateState.credentials.mcp_registration_mode ??
              (target.registration === "manual" ? "manual" : "unknown"),
          },
        });
        return record;
      },
    );
  });
}
export async function prepareNativeMcpCleanup(id: string): Promise<void> {
  await clearPreparedIntents(id);
  await retryRetainedNativeMcpPartialRefresh(id);
  await retryRetainedNativeOAuthGrants(id);
  await retryRetainedNativeMcpRegistration(id);
  await retainOrphanRegistration(id);
  const current = requireNativeMcpRecord(id);
  const entries = current.privateState.recovery;
  const hasUnsortedRegistration = entries.some(
    (entry, index) =>
      entry.kind === "registration" &&
      entries.slice(index + 1).some((next) => next.kind !== "registration"),
  );
  if (!entries.some(needsCleanup) && !hasUnsortedRegistration) return;
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      const mapped = record.privateState.recovery.map((entry) =>
        needsCleanup(entry) ? { ...entry, kind: "revoke" as const } : entry,
      );
      record.privateState.recovery = [
        ...mapped.filter((entry) => entry.kind !== "registration"),
        ...mapped.filter((entry) => entry.kind === "registration"),
      ];
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
      const {
        mcp_client: _removedClient,
        mcp_registration_mode: _removedMode,
        ...credentials
      } = record.privateState.credentials;
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

function validPartialToken(partial: string): boolean {
  return (
    partial.length > 0 && partial.length <= 32768 && /^[!-~]+$/.test(partial)
  );
}
function validPartialBinding(
  obligation: NativeRecovery,
  binding: NativeRecovery | NonNullable<NativeRecovery["grant"]>,
  target: ReturnType<typeof nativeMcpRecordOAuthTarget>,
  client: ReturnType<typeof nativeMcpClient>,
): boolean {
  const expected = target.binding;
  return (
    obligation.kind === "revoke" &&
    binding.providerId === expected.providerId &&
    binding.actor === "user" &&
    binding.fingerprint === expected.fingerprint &&
    binding.targetId === expected.resource &&
    binding.issuer === expected.issuer &&
    binding.resource === expected.resource &&
    binding.endpoint === expected.endpoint &&
    binding.clientId === client.client_id
  );
}
function partialRefreshToken(
  obligation: NativeRecovery,
  target: ReturnType<typeof nativeMcpRecordOAuthTarget>,
  client: ReturnType<typeof nativeMcpClient>,
): string | undefined {
  const partial =
    obligation.credentials?.phase === "partial-refresh"
      ? obligation.credentials.partial_refresh_token
      : undefined;
  const binding = obligation.grant ?? obligation;
  if (
    partial !== undefined &&
    (!validPartialBinding(obligation, binding, target, client) ||
      !validPartialToken(partial))
  )
    throw new NativeMcpAuthError("pending");
  return partial;
}

async function forgetLocalRegistration(id: string): Promise<void> {
  const current = requireNativeMcpRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    MCP_CLASSIFICATION,
    (record) => {
      const {
        mcp_client: _removed,
        mcp_registration_mode: _removedMode,
        ...credentials
      } = record.privateState.credentials;
      record.privateState.credentials = credentials;
      return record;
    },
  );
}
async function cleanupRegistration(
  obligation: NativeRecovery,
  context: NativeCleanupContext,
  target: Parameters<typeof removeRegistration>[1],
  client: Parameters<typeof removeRegistration>[2],
  transport: NativeProviderTransport,
) {
  if (
    ["manual", "cimd"].includes(obligation.credentials?.registration_mode ?? "")
  ) {
    await forgetLocalRegistration(context.connectionId);
    return "local-registration-forgotten" as const;
  }
  if (
    obligation.credentials?.phase !== "registered" ||
    !(await removeRegistration(context, target, client, transport))
  )
    throw new Error(
      "This MCP provider does not offer registration deletion; finish the retained registration authorization or remove it in provider settings",
    );
  return "provider-revoked" as const;
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
  if (obligation.kind === "registration")
    return cleanupRegistration(obligation, context, target, client, transport);
  const partial = partialRefreshToken(obligation, target, client);
  const grant = obligation.grant
    ? cleanupGrant(obligation, target, client)
    : undefined;
  if (!partial && !grant) throw new NativeMcpAuthError("pending");
  if (!target.metadata.revocationEndpoint) {
    return "local-credential-forgotten" as const;
  }
  const protocol = new NativeMcpPublicOAuth(target, {
    ...transport,
    signal: new AbortController().signal,
  });
  const refreshTokens = new Set(
    [partial, grant?.refreshToken].filter((value) => value !== undefined),
  );
  for (const token of refreshTokens)
    await protocol.revoke(client, token, "refresh_token");
  if (grant) await protocol.revoke(client, grant.accessToken, "access_token");
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
