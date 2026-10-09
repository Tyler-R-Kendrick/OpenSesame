/** Browser-supported self-hosted Vault/OpenBao: verified token access, no relay. */
import { NativeApiError } from "./native-api-http.js";
import {
  type NativeProviderCleanup,
  registerNativeProviderCleanup,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import type { NativeGrant } from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import {
  type NativeLocalInstanceFacts,
  lookupNativeLocalInstance,
  nativeLocalInstanceOrigin,
  revokeNativeLocalInstanceSelf,
} from "./native-local-instance-http.js";
import {
  nativeLocalInstanceGuard as guard,
  nativeLocalInstanceFingerprint,
  verifiedNativeLocalInstanceState,
} from "./native-local-instance-state.js";

const classification = {
  publicParameters: ["endpoint", "namespace"],
  privateCredentials: ["api_key"],
};
export interface NativeLocalInstanceInput {
  providerId: "vault" | "openbao";
  connectionId?: string;
  revision?: number;
  displayName: string;
  icon: string;
  endpoint: string;
  namespace: string;
  apiKey: string;
}
function requireInstance(id: string): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (
    !record ||
    !["vault", "openbao"].includes(record.configuration.providerId) ||
    record.configuration.method !== "api-key"
  )
    throw new Error("Saved provider instance not found");
  return record;
}
function resolveInstanceToken(
  input: NativeLocalInstanceInput,
  endpoint: string,
  existing: NativeConnectorRecord | null,
): string {
  let apiKey = input.apiKey;
  if (!apiKey) {
    if (
      !existing ||
      existing.configuration.parameters.endpoint !== endpoint ||
      existing.configuration.parameters.namespace !== input.namespace
    )
      throw new Error(
        "Enter a provider token for the selected instance and namespace",
      );
    const retained = existing.privateState.credentials.api_key;
    if (!retained) throw new Error("Enter a provider token");
    apiKey = retained;
  }
  return apiKey;
}
function validateInstanceReplacement(
  input: NativeLocalInstanceInput,
  existing: NativeConnectorRecord | null,
): void {
  if (existing && existing.configuration.providerId !== input.providerId)
    throw new Error("The saved connector belongs to another provider");
  if (
    existing &&
    (existing.privateState.recovery.length > 0 ||
      Object.keys(existing.privateState.pending).length > 0)
  )
    throw new Error("Complete provider cleanup before replacing this token");
  if (
    existing &&
    input.revision !== undefined &&
    input.revision !== existing.revision
  )
    throw new Error("Connector changed; reload the saved configuration");
}
export async function configureNativeLocalInstance(
  input: NativeLocalInstanceInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  if (!["vault", "openbao"].includes(input.providerId))
    throw new Error("This is not a supported provider instance");
  const endpoint = nativeLocalInstanceOrigin(input.endpoint);
  const existing = input.connectionId
    ? requireInstance(input.connectionId)
    : null;
  validateInstanceReplacement(input, existing);
  if (existing)
    await assertNativeConnectorRevision(existing.connectionId, guard(existing));
  const apiKey = resolveInstanceToken(input, endpoint, existing);
  const resolvedInput = { ...input, apiKey };
  const facts = await lookupNativeLocalInstance(
    endpoint,
    input.namespace,
    apiKey,
    transport,
  );
  facts.verifiedAt = Math.max(
    facts.verifiedAt,
    (existing?.privateState.verification?.verifiedAt ?? 0) + 1,
  );
  transport.assertCurrent();
  const binding = await nativeLocalInstanceFingerprint(resolvedInput, endpoint);
  const verified = verifiedNativeLocalInstanceState(
    resolvedInput,
    endpoint,
    binding,
    facts,
  );
  transport.assertCurrent();
  if (!existing)
    return saveNativeConnector(
      {
        connectionId: `conn_local_${crypto.randomUUID()}`,
        ...verified,
      },
      classification,
    );
  await updateNativeConnector(
    existing.connectionId,
    guard(existing),
    classification,
    (record) => {
      transport.assertCurrent();
      verified.privateState.recovery = Object.values(
        record.privateState.grants,
      ).map((grant) => {
        const targetId = grant.targetId ?? record.configuration.providerId;
        return {
          id: `replace:${grant.actor}:${record.revision}`,
          kind: "revoke" as const,
          providerId: grant.providerId,
          actor: grant.actor,
          fingerprint: grant.fingerprint,
          targetId,
          grant: { ...grant, targetId },
        };
      });
      return {
        ...record,
        ...verified,
      };
    },
  );
  return retryNativeConnectorCleanup(existing.connectionId);
}
export async function readNativeLocalInstance(
  connectionId: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeLocalInstanceFacts> {
  const record = requireInstance(connectionId);
  await assertNativeConnectorRevision(connectionId, guard(record));
  const token = record.privateState.credentials.api_key;
  if (!token) throw new Error("Verify this provider token again");
  let facts: NativeLocalInstanceFacts;
  try {
    facts = await lookupNativeLocalInstance(
      record.configuration.parameters.endpoint ?? "",
      record.configuration.parameters.namespace ?? "",
      token,
      transport,
    );
  } catch (error) {
    if (error instanceof NativeApiError && [401, 403].includes(error.status))
      await invalidateInstanceAuthorization(connectionId, record);
    throw error;
  }
  transport.assertCurrent();
  await assertNativeConnectorRevision(connectionId, guard(record));
  return facts;
}
/** Rechecks the retained token and atomically renews only the matching instance proof. */
export async function verifyNativeLocalInstance(
  connectionId: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const record = requireInstance(connectionId);
  if (
    record.privateState.recovery.length ||
    Object.keys(record.privateState.pending).length
  )
    throw new Error("Complete provider cleanup before verifying this token");
  const facts = await readNativeLocalInstance(connectionId, transport);
  facts.verifiedAt = Math.max(
    facts.verifiedAt,
    (record.privateState.verification?.verifiedAt ?? 0) + 1,
  );
  return updateNativeConnector(
    connectionId,
    guard(record),
    classification,
    (current) => {
      transport.assertCurrent();
      const token = current.privateState.credentials.api_key;
      if (!token) throw new Error("Enter a provider token");
      const verified = verifiedNativeLocalInstanceState(
        {
          providerId:
            current.configuration.providerId === "vault" ? "vault" : "openbao",
          displayName: current.configuration.displayName,
          icon: current.configuration.icon,
          endpoint: current.configuration.parameters.endpoint ?? "",
          namespace: current.configuration.parameters.namespace ?? "",
          apiKey: token,
        },
        current.configuration.parameters.endpoint ?? "",
        current.configuration.fingerprint,
        facts,
      );
      return { ...current, ...verified };
    },
  );
}
async function invalidateInstanceAuthorization(
  connectionId: string,
  record: NativeConnectorRecord,
): Promise<void> {
  await updateNativeConnector(
    connectionId,
    guard(record),
    classification,
    (current) => {
      current.privateState.verification = null;
      current.runtime.verifiedAt = null;
      current.runtime.grants = current.runtime.grants.map((grant) => ({
        ...grant,
        needsReauth: true,
      }));
      return current;
    },
  );
}
/** Explicit provider self-revocation may also affect other uses of this token. */
export async function revokeNativeLocalInstanceToken(
  connectionId: string,
  confirm: boolean,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<void> {
  if (confirm !== true)
    throw new Error("Confirm provider token revocation before continuing");
  const record = requireInstance(connectionId);
  await assertNativeConnectorRevision(connectionId, guard(record));
  const grant = record.privateState.grants.user;
  if (!grant) throw new Error("Verify this provider token again");
  const targetId = grant.targetId ?? record.configuration.providerId;
  await updateNativeConnector(
    connectionId,
    guard(record),
    classification,
    (current) => {
      transport.assertCurrent();
      current.privateState.recovery.push({
        id: `provider-self-revoke:${current.revision}`,
        providerId: grant.providerId,
        actor: grant.actor,
        fingerprint: grant.fingerprint,
        targetId,
        kind: "revoke",
        grant: { ...grant, targetId },
        credentials: {
          namespace: current.configuration.parameters.namespace ?? "",
        },
      });
      return current;
    },
  );
  transport.assertCurrent();
  await retryNativeConnectorCleanup(connectionId);
}
async function clearRevokedGrant(
  connectionId: string,
  revoked: NativeGrant,
): Promise<void> {
  const current = requireInstance(connectionId);
  await updateNativeConnector(
    connectionId,
    guard(current),
    classification,
    (record) => {
      const active = record.privateState.grants[revoked.actor];
      if (
        active?.accessToken !== revoked.accessToken ||
        active.fingerprint !== revoked.fingerprint
      )
        return record;
      delete record.privateState.grants[revoked.actor];
      if (record.privateState.credentials.api_key === revoked.accessToken)
        record.privateState.credentials = Object.fromEntries(
          Object.entries(record.privateState.credentials).filter(
            ([name]) => name !== "api_key",
          ),
        );
      record.privateState.verification = null;
      record.runtime.verifiedAt = null;
      record.runtime.grants = record.runtime.grants.map((grant) =>
        grant.actor === revoked.actor ? { ...grant, needsReauth: true } : grant,
      );
      return record;
    },
  );
}
export function nativeLocalInstanceCleanup(
  providerId: "vault" | "openbao",
  transport: NativeProviderTransport = nativeProviderTransport(),
): NativeProviderCleanup {
  return {
    classification: () => classification,
    credentialSlots: ["api_key"],
    cleanup: async (obligation, context) => {
      transport.assertCurrent();
      if (
        obligation.kind !== "revoke" ||
        obligation.providerId !== providerId ||
        obligation.grant?.kind !== "api-key"
      )
        throw new Error(
          "This provider cleanup requires its own recovery operation",
        );
      if (obligation.id.startsWith("provider-self-revoke:")) {
        await revokeNativeLocalInstanceSelf(
          obligation.grant.endpoint ?? "",
          obligation.credentials?.namespace ?? "",
          obligation.grant.accessToken,
          transport,
        );
        await clearRevokedGrant(context.connectionId, obligation.grant);
        return "provider-revoked";
      }
      return "local-credential-forgotten";
    },
  };
}
export function registerNativeLocalInstances(): () => void {
  const disposers: (() => void)[] = [];
  try {
    for (const providerId of ["vault", "openbao"] as const)
      disposers.push(
        registerNativeProviderCleanup(
          providerId,
          nativeLocalInstanceCleanup(providerId),
        ),
      );
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
