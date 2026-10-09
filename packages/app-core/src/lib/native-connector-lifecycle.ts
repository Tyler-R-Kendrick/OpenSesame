/** Provider cleanup is journaled before mutation and bound to one connection. */
import { canonicalize } from "@opensesame/os-domain";
import { lockManager } from "../ports.js";
import { deviceProviderRevokers } from "./device-connectors.js";
import { kvDurability } from "./kv.js";
import {
  type NativeConfiguration,
  type NativeFieldClassification,
  type NativeGrant,
  type NativePrivateState,
  type NativeRecovery,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
  readNativeConnector,
  removeNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeConnectorView } from "./native-connector-view.js";

export type NativeCleanupOutcome =
  | "provider-revoked"
  | "local-credential-forgotten";
export interface NativeCleanupContext {
  connectionId: string;
  configuration: NativeConfiguration;
  /** Await the seal before using a rotated grant for any provider mutation. */
  persistGrantRotation: (grant: NativeGrant) => Promise<void>;
}
export interface NativeProviderCleanup {
  classification: (
    configuration: NativeConfiguration,
  ) => NativeFieldClassification;
  credentialSlots?:
    | readonly string[]
    | ((
        configuration: NativeConfiguration,
        grant?: NativeGrant,
      ) => readonly string[]);
  /** Seal any retained issued grants before the cleanup snapshot or mutation. */
  prepare?: (connectionId: string) => Promise<void>;
  cleanup: (
    obligation: NativeRecovery,
    context: NativeCleanupContext,
  ) => Promise<NativeCleanupOutcome>;
}
const providers = new Map<string, NativeProviderCleanup>();
const running = new Map<string, Promise<unknown>>();

export function registerNativeProviderCleanup(
  providerId: string,
  adapter: NativeProviderCleanup,
): () => void {
  if (providers.has(providerId) || deviceProviderRevokers[providerId])
    throw new Error("Provider cleanup is already registered");
  const revoke = async (connectionId: string) => {
    if (providers.get(providerId) !== adapter)
      throw new Error("Provider cleanup runtime changed");
    const record = requiredRecord(connectionId);
    if (record.configuration.providerId !== providerId)
      throw new Error("Provider cleanup belongs to another connector");
    await removeNativeConnectorWithCleanup(connectionId);
  };
  providers.set(providerId, adapter);
  deviceProviderRevokers[providerId] = revoke;
  return () => {
    if (providers.get(providerId) === adapter) providers.delete(providerId);
    if (deviceProviderRevokers[providerId] === revoke)
      delete deviceProviderRevokers[providerId];
  };
}
function requiredRecord(connectionId: string): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(connectionId);
  if (!record) throw new Error("Saved native connector not found");
  return record;
}
function adapterFor(record: NativeConnectorRecord): NativeProviderCleanup {
  const adapter = providers.get(record.configuration.providerId);
  if (!adapter)
    throw new Error("Provider cleanup is unavailable on this device");
  return adapter;
}
function assertCleanupAdapter(
  connectionId: string,
  expected: NativeProviderCleanup,
): void {
  if (adapterFor(requiredRecord(connectionId)) !== expected)
    throw new Error(
      "Provider cleanup runtime changed; retry with the active connection",
    );
}
function guard(record: NativeConnectorRecord) {
  return {
    revision: record.revision,
    fingerprint: record.configuration.fingerprint,
  };
}
function withCleanupLock<T>(
  connectionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = running.get(connectionId) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(async () => {
      const locks = lockManager();
      if (!locks && kvDurability() === "persistent")
        throw new Error("Web Locks are required for shared provider cleanup");
      return locks
        ? locks.request(`opensesame:native-cleanup:${connectionId}`, action)
        : action();
    });
  running.set(connectionId, run);
  return run.finally(() => {
    if (running.get(connectionId) === run) running.delete(connectionId);
  });
}
function sameObligation(left: NativeRecovery, right: NativeRecovery): boolean {
  return canonicalize(left) === canonicalize(right);
}
function matchingEntry(
  record: NativeConnectorRecord,
  expected: NativeRecovery,
) {
  const entry = record.privateState.recovery.find(
    (candidate) => candidate.id === expected.id,
  );
  if (!entry || !sameObligation(entry, expected))
    throw new Error("Provider cleanup changed; reload before retrying");
  return entry;
}
function boundRotation(previous: NativeGrant, next: NativeGrant): void {
  for (const field of [
    "providerId",
    "actor",
    "fingerprint",
    "targetId",
    "kind",
    "issuer",
    "resource",
    "endpoint",
    "clientId",
  ] as const) {
    if (previous[field] !== next[field])
      throw new Error("Rotated authorization changed its provider binding");
  }
}
async function cleanupEntry(
  connectionId: string,
  initial: NativeRecovery,
  adapter: NativeProviderCleanup,
): Promise<void> {
  let expected = structuredClone(initial);
  assertCleanupAdapter(connectionId, adapter);
  const initialRecord = requiredRecord(connectionId);
  await assertNativeConnectorRevision(connectionId, guard(initialRecord));
  assertCleanupAdapter(connectionId, adapter);
  matchingEntry(initialRecord, expected);
  const outcome = await adapter.cleanup(structuredClone(expected), {
    connectionId,
    configuration: structuredClone(initialRecord.configuration),
    persistGrantRotation: async (grant) => {
      if (!expected.grant)
        throw new Error("Provider cleanup has no grant to rotate");
      boundRotation(expected.grant, grant);
      const current = requiredRecord(connectionId);
      const rotated = { ...expected, grant: structuredClone(grant) };
      await updateNativeConnector(
        connectionId,
        guard(current),
        adapter.classification(current.configuration),
        (record) => {
          assertCleanupAdapter(connectionId, adapter);
          matchingEntry(record, expected);
          record.privateState.recovery = record.privateState.recovery.map(
            (entry) => (entry.id === expected.id ? rotated : entry),
          );
          return record;
        },
      );
      expected = rotated;
    },
  });
  if (
    outcome !== "provider-revoked" &&
    outcome !== "local-credential-forgotten"
  )
    throw new Error("Provider cleanup did not complete");
  if (outcome === "local-credential-forgotten" && expected.kind !== "revoke")
    throw new Error("Remote provider configuration requires provider cleanup");
  const current = requiredRecord(connectionId);
  await updateNativeConnector(
    connectionId,
    guard(current),
    adapter.classification(current.configuration),
    (record) => {
      assertCleanupAdapter(connectionId, adapter);
      matchingEntry(record, expected);
      record.privateState.recovery = record.privateState.recovery.filter(
        (entry) => entry.id !== expected.id,
      );
      return record;
    },
  );
}
async function retryCleanup(
  connectionId: string,
  adapter: NativeProviderCleanup,
): Promise<NativeConnectorView> {
  assertCleanupAdapter(connectionId, adapter);
  try {
    await adapter.prepare?.(connectionId);
    assertCleanupAdapter(connectionId, adapter);
  } catch {
    throw new Error(
      "Provider cleanup failed; retry before removing this connection",
    );
  }
  const record = requiredRecord(connectionId);
  for (const entry of record.privateState.recovery) {
    try {
      await cleanupEntry(connectionId, entry, adapter);
    } catch {
      throw new Error(
        "Provider cleanup failed; retry before removing this connection",
      );
    }
  }
  const result = readNativeConnector(connectionId);
  if (!result) throw new Error("Saved native connector not found");
  return result;
}
export async function retryNativeConnectorCleanup(
  connectionId: string,
): Promise<NativeConnectorView> {
  const adapter = adapterFor(requiredRecord(connectionId));
  return withCleanupLock(connectionId, () =>
    retryCleanup(connectionId, adapter),
  );
}
function cleanupCredentials(
  record: NativeConnectorRecord,
  adapter: NativeProviderCleanup,
  grant: NativeGrant,
): NativePrivateState["credentials"] {
  const credentials: NativePrivateState["credentials"] = {};
  const selected = adapter.credentialSlots ?? [];
  const slots =
    "call" in selected ? selected(record.configuration, grant) : selected;
  const classified = adapter.classification(
    record.configuration,
  ).privateCredentials;
  for (const slot of slots) {
    if (!classified.includes(slot))
      throw new Error("Unknown provider cleanup credential slot");
    const value = record.privateState.credentials[slot];
    if (value !== undefined) credentials[slot] = value;
  }
  return credentials;
}
async function journalRemoval(
  connectionId: string,
  adapter: NativeProviderCleanup,
): Promise<void> {
  assertCleanupAdapter(connectionId, adapter);
  const current = requiredRecord(connectionId);
  await updateNativeConnector(
    connectionId,
    guard(current),
    adapter.classification(current.configuration),
    (record) => {
      assertCleanupAdapter(connectionId, adapter);
      const obligations = Object.entries(record.privateState.grants).map(
        ([actor, grant]): NativeRecovery => {
          const targetId =
            grant.targetId ??
            record.runtime.identity?.id ??
            record.configuration.providerId;
          return {
            id: `revoke:${actor}:${record.revision}`,
            kind: "revoke",
            providerId: grant.providerId,
            actor,
            fingerprint: grant.fingerprint,
            targetId,
            grant: { ...grant, targetId },
            credentials: cleanupCredentials(record, adapter, grant),
          };
        },
      );
      record.privateState = {
        ...record.privateState,
        grants: {},
        pending: {},
        verification: null,
        recovery: [...record.privateState.recovery, ...obligations],
      };
      record.runtime = emptyNativeRuntime();
      return record;
    },
  );
}
export async function removeNativeConnectorWithCleanup(
  connectionId: string,
): Promise<boolean> {
  const adapter = adapterFor(requiredRecord(connectionId));
  return withCleanupLock(connectionId, async () => {
    await journalRemoval(connectionId, adapter);
    await retryCleanup(connectionId, adapter);
    assertCleanupAdapter(connectionId, adapter);
    const current = requiredRecord(connectionId);
    const cleared = await updateNativeConnector(
      connectionId,
      guard(current),
      adapter.classification(current.configuration),
      (record) => {
        assertCleanupAdapter(connectionId, adapter);
        if (record.privateState.recovery.length > 0)
          throw new Error("Provider cleanup remains incomplete");
        if (
          Object.keys(record.privateState.grants).length > 0 ||
          Object.keys(record.privateState.pending).length > 0
        )
          throw new Error("Provider authorization changed during cleanup");
        record.privateState = emptyNativePrivate();
        record.runtime = emptyNativeRuntime();
        return record;
      },
    );
    return removeNativeConnector(connectionId, cleared);
  });
}
