/**
 * Vault lock fan-out that does not import the store.
 *
 * Several identity-plane modules need to wipe tab-local secrets on lock, but
 * they also sit on `store → remote-code → identity → device-identity → … →
 * local-sessions → store`. Registering against `vaultStore.onLock` at module
 * load therefore sees an unfinished export. This bus is the seam those
 * modules use instead: the store emits, they subscribe, and nothing in the
 * cycle imports the singleton.
 */

import { idleLockSeams } from "./idle-lock.js";

const handlers = new Set<() => void>();

/**
 * Lock after a waiting release has had a chance to save. Synchronous when
 * nothing asked to run first, so an ordinary idle lock stays what it was.
 */
export function lockAfterIdle(store: { lock: () => void }): void {
  const pending = idleLockSeams.beforeLock();
  if (pending) {
    void pending.finally(() => store.lock());
    return;
  }
  store.lock();
}

/** Run `handler` on every vault lock. Returns an unsubscribe. */
export function onVaultLock(handler: () => void): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/** Called from {@link VaultStore.lock} after local state is cleared. */
export function emitVaultLock(): void {
  for (const handler of handlers) {
    handler();
  }
}
