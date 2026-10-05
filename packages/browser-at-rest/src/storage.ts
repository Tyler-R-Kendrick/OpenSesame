/**
 * A sealed view of a synchronous store (ADR 0149): what a relying party's
 * SDK writes to `sessionStorage` reaches it as an at-rest seal bound to the
 * store's scope and the key, and is read back in the clear. The store keeps
 * its synchronous contract; sealing needs the origin's key, so the view is
 * asynchronous.
 *
 * Where no key can be kept, values are held in memory for the life of the
 * document: nothing is written in the clear. `set` says which happened, so a
 * value that must survive a navigation can be refused rather than lost. A
 * value an older release left in the clear is read as it is and sealed where
 * it lies.
 *
 * Writes land in the order they were asked for: a `remove` or a later `set`
 * cancels a seal still in flight, so a removed value never comes back.
 */

import {
  LEGACY_CLIENT_AT_REST_PREFIX,
  isSealedForRest,
  openFromRest,
  sealForRest,
} from "./seal.js";

/** The slice of Web Storage an SDK is handed. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Where a `set` left its value: sealed in the store, held in memory (the
 * origin keeps no key), or nowhere — a later `set`, `remove` or `take`
 * superseded it before its seal landed.
 */
export type SealedPlacement = "stored" | "memory" | "superseded";

export interface SealedStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<SealedPlacement>;
  remove(key: string): void;
  /**
   * Read and remove in one step: the value leaves the store before this
   * returns, so two callers racing for a one-time value (a PKCE verifier)
   * cannot both have it.
   */
  take(key: string): Promise<string | null>;
}

export function sealedStorage(
  storage: StorageLike,
  scope: string,
  legacyScope = scope,
): SealedStorage {
  const held = new Map<string, string>();
  /** Bumped by every write; a seal lands only if no newer write came since. */
  const version = new Map<string, number>();
  const bump = (key: string) => {
    const next = (version.get(key) ?? 0) + 1;
    version.set(key, next);
    return next;
  };

  async function write(key: string, value: string): Promise<SealedPlacement> {
    const mine = bump(key);
    const sealed = await sealForRest(scope, key, value);
    if (version.get(key) !== mine) return "superseded";
    if (sealed === null) {
      held.set(key, value);
      storage.removeItem(key);
      return "memory";
    }
    held.delete(key);
    storage.setItem(key, sealed);
    return "stored";
  }

  /**
   * Seal a value an older release left in the clear, where it lies — only if
   * nothing was written to the key meanwhile, and without superseding a
   * write already in flight.
   */
  async function reseal(key: string, raw: string): Promise<void> {
    const seen = version.get(key) ?? 0;
    const sealed = await sealForRest(scope, key, raw);
    if (sealed === null || (version.get(key) ?? 0) !== seen) return;
    if (storage.getItem(key) === raw) storage.setItem(key, sealed);
  }

  function open(key: string, raw: string | null): Promise<string | null> {
    if (raw === null) return Promise.resolve(null);
    if (!isSealedForRest(raw)) return Promise.resolve(raw);
    return openFromRest(
      raw.startsWith(LEGACY_CLIENT_AT_REST_PREFIX) ? legacyScope : scope,
      key,
      raw,
    );
  }

  return {
    async get(key) {
      const kept = held.get(key);
      if (kept !== undefined) return kept;
      const raw = storage.getItem(key);
      if (raw !== null && !isSealedForRest(raw)) {
        await reseal(key, raw);
        return raw;
      }
      return open(key, raw);
    },
    set: write,
    remove(key) {
      bump(key);
      held.delete(key);
      storage.removeItem(key);
    },
    take(key) {
      bump(key);
      const kept = held.get(key);
      const raw = storage.getItem(key);
      held.delete(key);
      storage.removeItem(key);
      return kept !== undefined ? Promise.resolve(kept) : open(key, raw);
    },
  };
}
