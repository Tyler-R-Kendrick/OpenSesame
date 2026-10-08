/**
 * OPFS kv with a one-time move off localStorage.
 * Drop claims and the sender ledger both used to sit in localStorage; the
 * copy is deleted once it has been moved.
 */

import { type WebStorage, maybeLocalStore } from "../../ports.js";
import { kvDelete, kvGet, kvSet } from "../kv.js";

export type OriginKvSlot = {
  storage: WebStorage;
  /** Forget the migration latch and both copies. Tests start from empty. */
  reset(): void;
};

function legacyStorage(): WebStorage | null {
  try {
    return maybeLocalStore() ?? null;
  } catch {
    return null;
  }
}

export function originKvSlot(keys: readonly string[]): OriginKvSlot {
  let migrated = false;

  function migrate(): void {
    if (migrated) return;
    migrated = true;
    const slot = legacyStorage();
    if (!slot) return;
    for (const key of keys) {
      const existing = slot.getItem(key);
      if (existing !== null && kvGet(key) === null) kvSet(key, existing);
      slot.removeItem(key);
    }
  }

  const storage: WebStorage = {
    get length(): number {
      return 0;
    },
    getItem(key: string): string | null {
      migrate();
      return kvGet(key);
    },
    key(): string | null {
      return null;
    },
    removeItem(key: string): void {
      kvDelete(key);
    },
    setItem(key: string, value: string): void {
      migrate();
      kvSet(key, value);
    },
  };

  return {
    storage,
    reset() {
      migrated = false;
      const slot = legacyStorage();
      for (const key of keys) {
        kvDelete(key);
        slot?.removeItem(key);
      }
    },
  };
}
