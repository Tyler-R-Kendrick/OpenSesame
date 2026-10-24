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

import { type BroadcastLike, openBroadcast } from "../../ports.js";
import { idleLockSeams } from "./idle-lock.js";

const handlers = new Set<() => void>();
const DESTROY_CHANNEL = "opensesame.vault-destroy.v1";
let destroyChannel: BroadcastLike | null | undefined;

function destroyNotice(): BroadcastLike | null {
  if (destroyChannel) return destroyChannel;
  try {
    // Do not cache a missing channel: a host may install BroadcastChannel
    // after an early call (tests, or a delayed capability).
    destroyChannel = openBroadcast(DESTROY_CHANNEL);
  } catch {
    destroyChannel = undefined;
  }
  return destroyChannel ?? null;
}

/**
 * Tell every other tab that this tomb was destroyed. The tomb name is a hint:
 * a receiver compares it with its own scope, then locks its session so a
 * stale key or header cannot be written back over the deletion.
 */
export function announceVaultDestroyed(tomb: string): void {
  try {
    destroyNotice()?.postMessage({ type: "destroyed", tomb });
  } catch {
    // A closed channel loses the hint; the open lease still fences writers.
  }
}

export function onVaultDestroyed(handler: (tomb: string) => void): () => void {
  const channel = destroyNotice();
  if (!channel) return () => undefined;
  const listener = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (
      data !== null &&
      typeof data === "object" &&
      "type" in data &&
      data.type === "destroyed" &&
      "tomb" in data &&
      typeof data.tomb === "string"
    )
      handler(data.tomb);
  };
  channel.addEventListener("message", listener);
  return () => channel.removeEventListener("message", listener);
}

/** Test-only: drop the cached channel so a new host/broadcast pair can open. */
export function resetVaultDestroyChannelForTest(): void {
  try {
    destroyChannel?.close();
  } catch {
    // already closed
  }
  destroyChannel = undefined;
}

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
