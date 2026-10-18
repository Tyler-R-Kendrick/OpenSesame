import { z } from "zod";
import type { Connection } from "../connections.js";
import { deviceProviderRevokers } from "../device-connectors.js";
import { createSecretBackend } from "./factory.js";
import {
  type HeldSecretBackend,
  type SecretBackendHandle as OpenBackend,
  assertSecretBackendSessionOpen,
  disposeSecretBackendProbe,
  holdSecretBackend,
} from "./runtime-admission.js";
import {
  awaitSecretBackendOwner,
  secretBackendVaultGuard,
} from "./runtime-guard.js";
import {
  advanceSecretBackendGeneration as advance,
  captureSecretBackendVault,
  registerPendingSecretBackend,
  secretBackendGeneration,
} from "./runtime-owners.js";
import { secretBackendDeviceSeams } from "./seam.js";
import {
  hydrateSecretBackendConnections,
  readSecretBackendConnection,
  removeSecretBackendConnection,
  resolveSecretBackendConfiguration,
  secretBackendConnectionVault,
  secretBackendRuntimeConfiguration,
  writeSecretBackendConnection,
} from "./store.js";
import {
  type SecretBackendConfiguration,
  type SecretBackendDraft,
  SecretBackendError,
} from "./types.js";

type VaultGuard = Awaited<ReturnType<typeof secretBackendVaultGuard>>;
const active = new Map<string, HeldSecretBackend>();
const SavedConnectionId = z.string();
function isSavedConnectionId(
  value: SecretBackendConfiguration | string,
): value is string {
  return SavedConnectionId.safeParse(value).success;
}
/** The factory retains its capability fence; tests can supply an actual protocol fixture. */
export const secretBackendRuntimeSeams = { createBackend: createSecretBackend };
function signature(connectionId: string, vaultTomb: string): string | null {
  const config = secretBackendRuntimeConfiguration(connectionId, vaultTomb);
  return config ? JSON.stringify(config) : null;
}
function assertVaultCurrent(guard: VaultGuard): void {
  if (!guard.current())
    throw new SecretBackendError(
      "stale",
      "The vault session ended. Unlock and try again.",
    );
}
function assertSavedScope(id: string, guard: VaultGuard): void {
  if (guard.guest || secretBackendConnectionVault(id) !== guard.tomb)
    throw new SecretBackendError(
      "stale",
      "Unlock the vault that saved this secret backend before using its credentials.",
    );
}
function lifecycle(
  guard: VaultGuard,
  id: string | undefined,
  before: string | null,
  generation: number,
) {
  let open = true;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([guard.signal, lifetime.signal]);
  const current = () =>
    open &&
    !signal.aborted &&
    guard.current() &&
    (!id ||
      (secretBackendGeneration(id) === generation &&
        signature(id, guard.tomb) === before));
  return {
    current,
    signal,
    check() {
      if (!current())
        throw new SecretBackendError(
          "stale",
          "The vault or backend configuration changed. Connect again.",
        );
    },
    close() {
      open = false;
      lifetime.abort();
      guard.close();
    },
  };
}
async function disconnectSaved(connectionId: string): Promise<void> {
  const held = active.get(connectionId);
  if (held) await held.close();
}
function releaseBackend(id: string | undefined, held: HeldSecretBackend): void {
  if (id && active.get(id) === held) {
    active.delete(id);
    secretBackendDeviceSeams.changed();
  }
}
function transientConfiguration(
  value: SecretBackendConfiguration,
  config: SecretBackendDraft,
): SecretBackendConfiguration {
  const resolved: SecretBackendConfiguration = { ...config };
  if (value.file) resolved.file = value.file;
  if (value.filePassword !== undefined)
    resolved.filePassword = value.filePassword;
  if (value.masterPassword !== undefined)
    resolved.masterPassword = value.masterPassword;
  return resolved;
}
async function authenticate(
  config: SecretBackendConfiguration,
  lease: ReturnType<typeof lifecycle>,
  savedConnectionId?: string,
  initialize = false,
): Promise<OpenBackend> {
  lease.check();
  if (initialize && config.mode !== "encrypted-remote")
    throw new SecretBackendError(
      "unsupported",
      "Only encrypted remote objects support explicit initialization.",
    );
  const backend = await awaitSecretBackendOwner(
    secretBackendRuntimeSeams.createBackend(
      config.mode,
      lease.check,
      lease.signal,
      savedConnectionId,
    ),
    lease.signal,
  );
  lease.check();
  if (initialize && (config.mode !== "encrypted-remote" || !backend.initialize))
    throw new SecretBackendError(
      "unsupported",
      "This backend does not support explicit empty-store initialization.",
    );
  const operation = initialize ? backend.initialize : backend.authenticate;
  if (!operation)
    throw new SecretBackendError(
      "unsupported",
      "Initialization is unavailable.",
    );
  const session = await awaitSecretBackendOwner(
    operation.call(backend, config),
    lease.signal,
    (late) => backend.disconnect(late),
  );
  try {
    lease.check();
    assertSecretBackendSessionOpen(session);
    return { backend, session };
  } catch (error) {
    lease.close();
    void backend.disconnect(session).catch(() => undefined);
    throw error;
  }
}

/** Configuration changes revoke prior admission before their guarded sealed commit. */
export async function saveSecretBackendConnection(
  draft: SecretBackendDraft,
  existingId?: string,
): Promise<Connection> {
  const guard = await secretBackendVaultGuard();
  try {
    if (guard.guest)
      throw new SecretBackendError(
        "unsupported",
        "Save secret backend credentials from a real vault, not a guest session.",
      );
    await hydrateSecretBackendConnections();
    assertVaultCurrent(guard);
    if (existingId) assertSavedScope(existingId, guard);
    const before = existingId ? signature(existingId, guard.tomb) : null;
    const resolved = resolveSecretBackendConfiguration(
      draft,
      existingId,
      guard.tomb,
    );
    const generation = existingId ? advance(existingId) : 0;
    const lease = lifecycle(guard, existingId, before, generation);
    lease.check();
    if (existingId) await disconnectSaved(existingId);
    lease.check();
    return await writeSecretBackendConnection(
      resolved,
      guard.tomb,
      existingId,
      lease.check,
      () => assertVaultCurrent(guard),
    );
  } finally {
    guard.close();
  }
}

export function connectSecretBackend(
  value: SecretBackendConfiguration | string,
  existingId?: string,
  callerSignal?: AbortSignal,
): Promise<OpenBackend> {
  return openSecretBackend(value, existingId, callerSignal);
}
function assertUnchangedConfiguration(
  config: SecretBackendDraft,
  id: string | undefined,
  tomb: string,
  before: string | null,
): void {
  if (!id) return;
  if (
    !before ||
    JSON.stringify(resolveSecretBackendConfiguration(config, id, tomb)) !==
      before
  )
    throw new SecretBackendError(
      "stale",
      "Save configuration changes before connecting.",
    );
}
/** Separate explicit creation: never invoked by connect or probe. */
export function initializeSecretBackend(
  connectionId: string,
  callerSignal?: AbortSignal,
): Promise<OpenBackend> {
  return openSecretBackend(connectionId, undefined, callerSignal, true);
}
async function openSecretBackend(
  value: SecretBackendConfiguration | string,
  existingId?: string,
  callerSignal?: AbortSignal,
  initialize = false,
): Promise<OpenBackend> {
  const guard = await captureSecretBackendVault(callerSignal);
  let retained = false;
  let close = guard.close;
  let releasePending = () => {};
  try {
    assertVaultCurrent(guard);
    await awaitSecretBackendOwner(
      hydrateSecretBackendConnections(),
      guard.signal,
    );
    assertVaultCurrent(guard);
    const id = isSavedConnectionId(value) ? value : existingId;
    if (id) assertSavedScope(id, guard);
    const config = isSavedConnectionId(value)
      ? secretBackendRuntimeConfiguration(value, guard.tomb)
      : resolveSecretBackendConfiguration(value, existingId, guard.tomb);
    if (!config)
      throw new SecretBackendError(
        "configuration",
        "Saved secret backend not found.",
      );
    const before = id ? signature(id, guard.tomb) : null;
    assertUnchangedConfiguration(config, id, guard.tomb, before);
    const generation = id ? advance(id) : 0;
    const lease = lifecycle(guard, id, before, generation);
    close = lease.close;
    releasePending = registerPendingSecretBackend(id, generation, lease);
    if (id) await awaitSecretBackendOwner(disconnectSaved(id), lease.signal);
    lease.check();
    const input = isSavedConnectionId(value)
      ? config
      : transientConfiguration(value, config);
    const raw = await authenticate(input, lease, id, initialize);
    const held = holdSecretBackend(raw, lease, (entry) =>
      releaseBackend(id, entry),
    );
    guard.onInvalidated(() => {
      void held.close().catch(() => undefined);
    });
    try {
      held.check();
      if (id) {
        active.set(id, held);
        deviceProviderRevokers[config.providerId] = async (connectionId) => {
          await deleteSecretBackendConnection(connectionId);
        };
        secretBackendDeviceSeams.changed();
      }
      held.check();
      retained = true;
      return {
        backend: held.backend,
        session: held.session,
        signal: held.signal,
      };
    } catch (error) {
      void held.close().catch(() => undefined);
      throw error;
    }
  } finally {
    releasePending();
    if (!retained) close();
  }
}

/** Read-only probes spend only the supplied configuration and always dispose the SDK handle. */
export async function probeSecretBackend(
  draft: SecretBackendConfiguration,
  existingId?: string,
  callerSignal?: AbortSignal,
): Promise<void> {
  const guard = await captureSecretBackendVault(callerSignal);
  let close = guard.close;
  let releasePending = () => {};
  try {
    assertVaultCurrent(guard);
    await awaitSecretBackendOwner(
      hydrateSecretBackendConnections(),
      guard.signal,
    );
    assertVaultCurrent(guard);
    if (existingId) assertSavedScope(existingId, guard);
    const before = existingId ? signature(existingId, guard.tomb) : null;
    const generation = existingId ? secretBackendGeneration(existingId) : 0;
    const lease = lifecycle(guard, existingId, before, generation);
    close = lease.close;
    releasePending = registerPendingSecretBackend(
      existingId,
      generation,
      lease,
    );
    lease.check();
    const config = resolveSecretBackendConfiguration(
      draft,
      existingId,
      guard.tomb,
    );
    const raw = await authenticate(
      transientConfiguration(draft, config),
      lease,
      existingId,
    );
    await disposeSecretBackendProbe(raw, lease);
  } finally {
    releasePending();
    close();
  }
}

export async function deleteSecretBackendConnection(
  connectionId: string,
): Promise<boolean> {
  const guard = await secretBackendVaultGuard();
  try {
    await hydrateSecretBackendConnections();
    assertVaultCurrent(guard);
    assertSavedScope(connectionId, guard);
    const before = signature(connectionId, guard.tomb);
    const lease = lifecycle(guard, connectionId, before, advance(connectionId));
    lease.check();
    await disconnectSaved(connectionId);
    lease.check();
    return await removeSecretBackendConnection(
      connectionId,
      guard.tomb,
      lease.check,
      () => assertVaultCurrent(guard),
    );
  } finally {
    guard.close();
  }
}

secretBackendDeviceSeams.authorization = (connectionId) => {
  if (!readSecretBackendConnection(connectionId)) return null;
  const held = active.get(connectionId);
  const connected = Boolean(held?.current());
  return {
    status: connected ? "active" : "pending",
    statusDetail: connected
      ? "Connected to secret backend"
      : "Configured; connect to access items",
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
  };
};
secretBackendDeviceSeams.revoke = async (connectionId) => {
  await deleteSecretBackendConnection(connectionId);
};
