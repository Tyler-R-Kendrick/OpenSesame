/** Native records share the sealed atomic ledger and its cross-tab write lock. */
import { canonicalize } from "@opensesame/os-domain";
import type { DeviceConfiguration } from "./device-connector-records.js";
import {
  readDeviceRows,
  readDeviceSecrets,
  removeDeviceConfigurationDurable,
  updateDeviceConfigurationDurable,
  writeDeviceConfigurationDurable,
} from "./device-connector-records.js";
import {
  type NativeConfiguration,
  NativeConfigurationSchema,
  type NativeFieldClassification,
  type NativeGrant,
  NativePrivateSchema,
  type NativePrivateState,
  type NativeRecovery,
  type NativeRuntime,
  NativeRuntimeSchema,
  NativeSealedSchema,
  validateNativeConfiguration,
} from "./native-connector-schema.js";
import {
  type NativeConnectorView,
  nativeConnectorView,
} from "./native-connector-view.js";

const CONFIGURATION = "native_configuration";
const RUNTIME = "native_runtime";
const REVISION = "native_revision";
const PRIVATE = "native_authority";
export interface NativeConnectorRecord {
  connectionId: string;
  revision: number;
  configuration: NativeConfiguration;
  runtime: NativeRuntime;
  privateState: NativePrivateState;
}
export interface NativeRevisionGuard {
  revision: number;
  fingerprint: string;
}

function parseRecord(record: DeviceConfiguration): NativeConnectorRecord {
  try {
    const parsedConfiguration = NativeConfigurationSchema.parse(
      JSON.parse(record.row.fields[CONFIGURATION] ?? ""),
    );
    const runtime = NativeRuntimeSchema.parse(
      JSON.parse(record.row.fields[RUNTIME] ?? ""),
    );
    const sealed = NativeSealedSchema.parse(
      JSON.parse(record.secrets[PRIVATE] ?? ""),
    );
    const configuration = validateNativeConfiguration(
      parsedConfiguration,
      sealed.classification,
    );
    const { privateState } = sealed;
    validateSlots(privateState, sealed.classification);
    const revision = Number(record.row.fields[REVISION]);
    if (
      configuration.providerId !== record.row.providerId ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw new Error("Invalid binding");
    const result = {
      connectionId: record.row.connectionId,
      revision,
      configuration,
      runtime,
      privateState,
    };
    validateBinding(result);
    return result;
  } catch {
    throw new Error("Saved native connector is invalid");
  }
}

/** Trusted coordinator only: never expose this result through UI or agent APIs. */
export function loadNativeConnectorRecord(
  connectionId: string,
): NativeConnectorRecord | null {
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === connectionId,
  );
  if (!row || row.fields[CONFIGURATION] === undefined) return null;
  return parseRecord({
    row,
    secrets: readDeviceSecrets()[connectionId] ?? {},
  });
}

export function readNativeConnector(
  connectionId: string,
): NativeConnectorView | null {
  const record = loadNativeConnectorRecord(connectionId);
  return record ? view(record) : null;
}
function view(record: NativeConnectorRecord): NativeConnectorView {
  return nativeConnectorView(
    record.connectionId,
    record.revision,
    record.configuration,
    record.runtime,
    record.privateState,
  );
}
function validateBinding(record: NativeConnectorRecord): void {
  const { configuration, privateState } = record;
  for (const [actor, entry] of [
    ...Object.entries(privateState.grants),
    ...Object.entries(privateState.pending),
  ]) {
    if (
      entry.providerId !== configuration.providerId ||
      entry.fingerprint !== configuration.fingerprint ||
      entry.actor !== actor
    )
      throw new Error(
        "Provider authorization belongs to another configuration",
      );
  }
  for (const grant of Object.values(privateState.grants)) {
    validateMcpAudience(grant);
  }
  for (const recovery of privateState.recovery) {
    if (recovery.providerId !== configuration.providerId)
      throw new Error("Provider cleanup belongs to another connector");
    validateRecoveryBinding(recovery);
  }
}
function validateMcpAudience(grant: NativeGrant): void {
  if (
    grant.kind === "mcp" &&
    (!grant.issuer || !grant.resource || !grant.endpoint || !grant.clientId)
  )
    throw new Error("MCP authorization is missing its audience binding");
}
function validateRecoveryBinding(recovery: NativeRecovery): void {
  const grant = recovery.grant;
  if (
    grant &&
    (grant.providerId !== recovery.providerId ||
      grant.actor !== recovery.actor ||
      grant.fingerprint !== recovery.fingerprint ||
      grant.targetId !== recovery.targetId)
  )
    throw new Error("Provider cleanup grant does not match its target");
  if (!grant) return;
  validateMcpAudience(grant);
  for (const field of ["issuer", "resource", "endpoint", "clientId"] as const) {
    if (recovery[field] !== undefined && recovery[field] !== grant[field])
      throw new Error("Provider cleanup grant does not match its audience");
  }
}
function validateSlots(
  privateState: NativePrivateState,
  classification: NativeFieldClassification,
): void {
  for (const slot of Object.keys(privateState.credentials)) {
    if (!classification.privateCredentials.includes(slot))
      throw new Error("Unknown private provider credential slot");
  }
}
function encodeRecord(
  record: NativeConnectorRecord,
  classification: NativeFieldClassification,
  createdAt: string,
): DeviceConfiguration {
  const configuration = validateNativeConfiguration(
    record.configuration,
    classification,
  );
  const runtime = NativeRuntimeSchema.parse(record.runtime);
  const privateState = NativePrivateSchema.parse(record.privateState);
  validateSlots(privateState, classification);
  validateBinding({ ...record, configuration, runtime, privateState });
  return {
    row: {
      connectionId: record.connectionId,
      providerId: configuration.providerId,
      displayName: configuration.displayName,
      scopes: runtime.grants.flatMap((grant) => grant.grantedScopes),
      fields: {
        [CONFIGURATION]: JSON.stringify(configuration),
        [RUNTIME]: JSON.stringify(runtime),
        [REVISION]: String(record.revision),
        self_hosted_configuration: "native-v1",
      },
      createdAt,
      updatedAt: new Date().toISOString(),
    },
    secrets: {
      [PRIVATE]: JSON.stringify({ privateState, classification }),
    },
  };
}

export async function saveNativeConnector(
  record: Omit<NativeConnectorRecord, "revision">,
  classification: NativeFieldClassification,
  beforeCommit?: () => void,
): Promise<NativeConnectorView> {
  const next = { ...record, revision: 1 };
  let committed: NativeConnectorRecord | null = null;
  await writeDeviceConfigurationDurable(() => {
    if (
      readDeviceRows().some((row) => row.connectionId === record.connectionId)
    )
      throw new Error("Connector already exists; use a guarded update");
    const encoded = encodeRecord(
      next,
      classification,
      new Date().toISOString(),
    );
    committed = parseRecord(encoded);
    return encoded;
  }, beforeCommit);
  if (!committed) throw new Error("Native connector was not committed");
  return view(committed);
}
function assertRevision(
  record: NativeConnectorRecord,
  guard: NativeRevisionGuard,
): void {
  if (
    record.revision !== guard.revision ||
    record.configuration.fingerprint !== guard.fingerprint
  )
    throw new Error("Connector changed; reload before retrying");
}
/** Refresh under the shared lock before accepting an awaited provider result. */
export async function assertNativeConnectorRevision(
  connectionId: string,
  expected: NativeRevisionGuard,
): Promise<void> {
  await updateDeviceConfigurationDurable(connectionId, async (stored) => {
    assertRevision(parseRecord(stored), expected);
    return stored;
  });
}
function assertIdentityBinding(
  current: NativeConnectorRecord,
  next: NativeConnectorRecord,
): void {
  const previous = current.runtime.identity;
  const identity = next.runtime.identity;
  if (
    next.privateState.verification &&
    current.configuration.fingerprint === next.configuration.fingerprint &&
    previous &&
    identity &&
    (previous.id !== identity.id || previous.kind !== identity.kind)
  )
    throw new Error("Verified identity changed; replace the connector binding");
}
function invalidateChangedAuthority(
  current: NativeConnectorRecord,
  next: NativeConnectorRecord,
): void {
  const authority = (record: NativeConnectorRecord) =>
    canonicalize({
      ...record.configuration,
      displayName: "",
      icon: "",
      credentials: record.privateState.credentials,
      grants: record.privateState.grants,
    });
  if (
    authority(current) !== authority(next) &&
    canonicalize(current.privateState.verification) ===
      canonicalize(next.privateState.verification)
  ) {
    next.privateState.verification = null;
    next.runtime.verifiedAt = null;
    next.runtime.grants = next.runtime.grants.map((grant) => ({
      ...grant,
      needsReauth: true,
    }));
  }
}

/** Full record guard preserves concurrent grant rotations and cleanup journals. */
export async function updateNativeConnector(
  connectionId: string,
  guard: NativeRevisionGuard,
  classification: NativeFieldClassification,
  update: (record: NativeConnectorRecord) => NativeConnectorRecord,
  beforeCommit?: () => void,
): Promise<NativeConnectorView> {
  let result: NativeConnectorRecord | null = null;
  await updateDeviceConfigurationDurable(
    connectionId,
    async (stored) => {
      const current = parseRecord(stored);
      assertRevision(current, guard);
      const next = update(structuredClone(current));
      if (
        next.connectionId !== connectionId ||
        next.configuration.providerId !== current.configuration.providerId ||
        next.revision !== current.revision
      )
        throw new Error("A native update cannot replace its connector binding");
      assertIdentityBinding(current, next);
      invalidateChangedAuthority(current, next);
      const encoded = encodeRecord(
        { ...next, revision: current.revision + 1 },
        classification,
        stored.row.createdAt,
      );
      result = parseRecord(encoded);
      return encoded;
    },
    beforeCommit,
  );
  if (!result) throw new Error("Native connector update was not committed");
  return view(result);
}

/** Provider cleanup must finish first; a stale removal cannot forget fresh grants. */
export function removeNativeConnector(
  connectionId: string,
  guard: NativeRevisionGuard,
): Promise<boolean> {
  return removeDeviceConfigurationDurable(connectionId, (stored) => {
    const record = parseRecord(stored);
    assertRevision(record, guard);
    if (
      record.privateState.recovery.length > 0 ||
      Object.keys(record.privateState.pending).length > 0 ||
      Object.keys(record.privateState.grants).length > 0
    )
      throw new Error(
        "Provider authorization cleanup must finish before removal",
      );
  });
}
