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

const handlers = new Set<() => void>();

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
