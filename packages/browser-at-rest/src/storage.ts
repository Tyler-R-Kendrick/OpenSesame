/**
 * A sealed view of a synchronous store (ADR 0148): what a relying party's
 * SDK writes to `sessionStorage` reaches it as an at-rest seal bound to the
 * store's scope and the key, and is read back in the clear. The store keeps
 * its synchronous contract; sealing needs the origin's key, so the view is
 * asynchronous.
 *
 * Where no key can be kept, values are held in memory for the life of the
 * document: nothing is written in the clear. A value an older release left
 * in the clear is read as it is and sealed where it lies.
 */

import { isSealedForRest, openFromRest, sealForRest } from "./seal.js";

/** The slice of Web Storage an SDK is handed. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SealedStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): void;
}

export function sealedStorage(
  storage: StorageLike,
  scope: string,
): SealedStorage {
  const held = new Map<string, string>();
  async function write(key: string, value: string): Promise<void> {
    const sealed = await sealForRest(scope, key, value);
    if (sealed === null) {
      held.set(key, value);
      storage.removeItem(key);
      return;
    }
    held.delete(key);
    storage.setItem(key, sealed);
  }
  return {
    async get(key) {
      const kept = held.get(key);
      if (kept !== undefined) return kept;
      const raw = storage.getItem(key);
      if (raw === null) return null;
      if (!isSealedForRest(raw)) {
        await write(key, raw);
        return raw;
      }
      return openFromRest(scope, key, raw);
    },
    set: write,
    remove(key) {
      held.delete(key);
      storage.removeItem(key);
    },
  };
}
