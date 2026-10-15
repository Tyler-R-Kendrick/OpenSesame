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
const generations = new Map<string, number>();
const SavedConnectionId = z.string();
function isSavedConnectionId(
  value: SecretBackendConfiguration | string,
): value is string {
  return SavedConnectionId.safeParse(value).success;
}
function advance(connectionId: string): number {
  const next = (generations.get(connectionId) ?? 0) + 1;
  generations.set(connectionId, next);
  return next;
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
      (generations.get(id) === generation &&
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
  return resolved;
}
async function authenticate(
  config: SecretBackendConfiguration,
  lease: ReturnType<typeof lifecycle>,
): Promise<OpenBackend> {
  lease.check();
  const backend = await awaitSecretBackendOwner(
    secretBackendRuntimeSeams.createBackend(
      config.mode,
      lease.check,
      lease.signal,
    ),
    lease.signal,
  );
  lease.check();
  const session = await awaitSecretBackendOwner(
    backend.authenticate(config),
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

export async function connectSecretBackend(
  value: SecretBackendConfiguration | string,
  existingId?: string,
): Promise<OpenBackend> {
  const guard = await secretBackendVaultGuard();
  let retained = false;
  let close = guard.close;
  try {
    await hydrateSecretBackendConnections();
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
    if (
      id &&
      (!before ||
        JSON.stringify(
          resolveSecretBackendConfiguration(config, id, guard.tomb),
        ) !== before)
    )
      throw new SecretBackendError(
        "stale",
        "Save configuration changes before connecting.",
      );
    const generation = id ? advance(id) : 0;
    const lease = lifecycle(guard, id, before, generation);
    close = lease.close;
    if (id) await awaitSecretBackendOwner(disconnectSaved(id), lease.signal);
    lease.check();
    const input = isSavedConnectionId(value)
      ? config
      : transientConfiguration(value, config);
    const raw = await authenticate(input, lease);
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
    if (!retained) close();
  }
}

/** Read-only probes spend only the supplied configuration and always dispose the SDK handle. */
export async function probeSecretBackend(
  draft: SecretBackendConfiguration,
  existingId?: string,
): Promise<void> {
  const guard = await secretBackendVaultGuard();
  let close = guard.close;
  try {
    await hydrateSecretBackendConnections();
    assertVaultCurrent(guard);
    if (existingId) assertSavedScope(existingId, guard);
    const before = existingId ? signature(existingId, guard.tomb) : null;
    const generation = existingId ? (generations.get(existingId) ?? 0) : 0;
    if (existingId && !generations.has(existingId))
      generations.set(existingId, generation);
    const lease = lifecycle(guard, existingId, before, generation);
    close = lease.close;
    lease.check();
    const config = resolveSecretBackendConfiguration(
      draft,
      existingId,
      guard.tomb,
    );
    const raw = await authenticate(
      transientConfiguration(draft, config),
      lease,
    );
    await disposeSecretBackendProbe(raw, lease);
  } finally {
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
