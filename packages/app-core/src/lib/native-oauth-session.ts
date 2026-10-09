import { readDeviceRows } from "./device-connector-records.js";
/** Single-use callback claims become durable obligations before a credential request. */
import type {
  NativeConfiguration,
  NativeFieldClassification,
  NativeGrant,
  NativePending,
  NativeRecovery,
} from "./native-connector-schema.js";
import {
  type NativeConnectorRecord,
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import { NativeOAuthError } from "./native-oauth-errors.js";

export function requireNativeOAuthRecord(id: string): NativeConnectorRecord {
  const record = loadNativeConnectorRecord(id);
  if (!record || !["oauth", "mcp"].includes(record.configuration.method))
    throw new NativeOAuthError("callback");
  return record;
}
export function nativeOAuthGuard(record: NativeConnectorRecord) {
  return {
    revision: record.revision,
    fingerprint: record.configuration.fingerprint,
  };
}
type RetainedGrant = {
  grant: NativeGrant;
  extra: Record<string, string>;
  classification: (
    configuration: NativeConfiguration,
  ) => NativeFieldClassification;
  rotation: boolean;
};
const retained = new Map<string, Map<string, RetainedGrant>>();
const inFlight = new Set<string>();
export function nativeOAuthMutationInFlight(
  id: string,
  intentId: string,
): boolean {
  return inFlight.has(`${id}:${intentId}`);
}
export function markNativeOAuthMutationInFlight(
  id: string,
  intentId: string,
): () => void {
  const key = `${id}:${intentId}`;
  if (inFlight.has(key)) throw new NativeOAuthError("callback");
  inFlight.add(key);
  return () => {
    inFlight.delete(key);
  };
}
export function forgetRetainedNativeOAuthGrant(
  id: string,
  intentId: string,
): void {
  const entries = retained.get(id);
  entries?.delete(intentId);
  if (entries?.size === 0) retained.delete(id);
}
export async function retryRetainedNativeOAuthGrants(
  id: string,
): Promise<void> {
  const entries = retained.get(id);
  if (!entries) return;
  for (const [intentId, entry] of [...entries])
    await journalNativeOAuthGrant(
      id,
      intentId,
      entry.grant,
      entry.classification,
      entry.extra,
      entry.rotation,
    );
}
export type NativeOAuthCallback = {
  state: string;
  code: string | null;
  error: boolean;
};
export function parseNativeOAuthCallback(search: string): NativeOAuthCallback {
  const query = new URLSearchParams(search);
  const state = query.get("native_state");
  const code = query.get("native_code");
  const error = query.has("native_error");
  if (
    !state ||
    state.length < 32 ||
    state.length > 512 ||
    !!code === error ||
    (code?.length ?? 0) > 4096
  )
    throw new NativeOAuthError("callback");
  for (const key of ["native_state", "native_code", "native_error"])
    if (query.getAll(key).length > 1) throw new NativeOAuthError("callback");
  return { state, code, error };
}
export function findNativeOAuthPending(
  state: string,
): { record: NativeConnectorRecord; pending: NativePending } | null {
  let found: { record: NativeConnectorRecord; pending: NativePending } | null =
    null;
  for (const row of readDeviceRows()) {
    const record = loadNativeConnectorRecord(row.connectionId);
    if (!record) continue;
    for (const pending of Object.values(record.privateState.pending)) {
      if (pending.state !== state) continue;
      if (found) throw new NativeOAuthError("callback");
      found = { record, pending };
    }
  }
  return found;
}
export function nativeOAuthCallbackTarget(search: string) {
  const match = findNativeOAuthPending(parseNativeOAuthCallback(search).state);
  if (!match) return null;
  return {
    connectionId: match.record.connectionId,
    providerId: match.pending.providerId,
    method: match.record.configuration.method,
    actor: match.pending.actor,
  };
}
export function nativeOAuthObligation(
  pending: NativePending,
  identityId?: string,
): NativeRecovery {
  const credentials = {
    phase: "exchange",
    deadline: String(Date.now() + 60_000),
    identity_id: identityId ?? "",
  };
  return {
    id: `oauth:${pending.state}`,
    kind: "configure",
    providerId: pending.providerId,
    actor: pending.actor,
    fingerprint: pending.fingerprint,
    targetId: pending.targetId ?? pending.providerId,
    issuer: pending.issuer,
    resource: pending.resource,
    endpoint: pending.endpoint,
    clientId: pending.clientId,
    credentials,
  };
}
export type NativeOAuthClaim = {
  record: NativeConnectorRecord;
  pending: NativePending;
  obligation: NativeRecovery;
  code: string;
};
export async function claimNativeOAuthPending(
  search: string,
  classification: NativeFieldClassification,
): Promise<NativeOAuthClaim> {
  const callback = parseNativeOAuthCallback(search);
  const found = findNativeOAuthPending(callback.state);
  if (!found) throw new NativeOAuthError("callback");
  const { record, pending } = found;
  const invalid =
    pending.expiresAt <= Date.now() ||
    pending.fingerprint !== record.configuration.fingerprint;
  const obligation = nativeOAuthObligation(
    pending,
    record.runtime.identity?.id,
  );
  await updateNativeConnector(
    record.connectionId,
    nativeOAuthGuard(record),
    classification,
    (current) => {
      const actual = current.privateState.pending[pending.actor];
      if (actual?.state !== pending.state)
        throw new NativeOAuthError("callback");
      delete current.privateState.pending[pending.actor];
      if (!callback.error && !invalid)
        current.privateState.recovery.push(obligation);
      current.privateState.verification = null;
      return current;
    },
  );
  if (invalid) throw new NativeOAuthError("expired");
  if (callback.error || !callback.code) throw new NativeOAuthError("denied");
  return {
    record: requireNativeOAuthRecord(record.connectionId),
    pending,
    obligation,
    code: callback.code,
  };
}
export async function journalNativeOAuthGrant(
  id: string,
  obligationId: string,
  grant: NativeGrant,
  classification: (
    configuration: NativeConfiguration,
  ) => NativeFieldClassification,
  extra: Record<string, string> = {},
  rotation = false,
): Promise<void> {
  const entries = retained.get(id) ?? new Map<string, RetainedGrant>();
  if (entries.size >= 64 && !entries.has(obligationId))
    throw new NativeOAuthError("storage");
  entries.set(obligationId, {
    grant: structuredClone(grant),
    extra: { ...extra },
    classification,
    rotation,
  });
  retained.set(id, entries);
  const current = requireNativeOAuthRecord(id);
  await updateNativeConnector(
    id,
    nativeOAuthGuard(current),
    classification(current.configuration),
    (record) => {
      const intent = record.privateState.recovery.find(
        (entry) => entry.id === obligationId,
      );
      if (
        !intent ||
        intent.fingerprint !== grant.fingerprint ||
        (intent.grant && intent.credentials?.phase !== "refresh" && !rotation)
      )
        throw new NativeOAuthError("storage");
      if (rotation && intent.grant) assertOAuthRotation(intent.grant, grant);
      if (!rotation && intent.credentials?.phase === "refresh") {
        delete record.privateState.grants[grant.actor];
        record.runtime.grants = record.runtime.grants.filter(
          (entry) => entry.actor !== grant.actor,
        );
      }
      intent.grant = { ...grant, targetId: intent.targetId };
      intent.credentials = {
        ...intent.credentials,
        ...extra,
        phase: rotation ? (intent.credentials?.phase ?? "verify") : "verify",
      };
      return record;
    },
  );
  forgetRetainedNativeOAuthGrant(id, obligationId);
}
function assertOAuthRotation(previous: NativeGrant, next: NativeGrant): void {
  for (const key of [
    "providerId",
    "actor",
    "fingerprint",
    "kind",
    "targetId",
    "issuer",
    "resource",
    "endpoint",
    "clientId",
  ] as const)
    if (previous[key] !== next[key]) throw new NativeOAuthError("storage");
}
export function retainNativeOAuthRotationForRetry(
  id: string,
  intentId: string,
  grant: NativeGrant,
  classification: (
    configuration: NativeConfiguration,
  ) => NativeFieldClassification,
): void {
  const entries = retained.get(id) ?? new Map<string, RetainedGrant>();
  entries.set(intentId, {
    grant: structuredClone(grant),
    extra: {},
    classification,
    rotation: true,
  });
  retained.set(id, entries);
}
