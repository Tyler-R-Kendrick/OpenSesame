/**
 * Wallet localStorage must follow the active vault tomb so a guest
 * cannot read or close the personal ledger.
 */

import { vaultStore } from "./vault/store.js";

let override: string | null = null;
let lastTomb = "personal";
const listeners = new Set<() => void>();

function notifyIfChanged(id: string): string {
  if (id !== lastTomb) {
    lastTomb = id;
    for (const listener of listeners) listener();
  }
  return id;
}

export function walletStorageTomb(): string {
  if (override !== null) return notifyIfChanged(override);
  try {
    const id = vaultStore.activeTomb().trim();
    return notifyIfChanged(id === "" ? "personal" : id);
  } catch {
    return notifyIfChanged("personal");
  }
}

export function setWalletStorageTomb(next: string): void {
  override = next.trim() === "" ? "personal" : next;
  notifyIfChanged(override);
}

export function onWalletTombChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function walletStorageKey(base: string): string {
  return `${base}.${walletStorageTomb()}`;
}

/** Personal-scope fallback: unsuffixed keys from before tomb scoping. */
export function readWalletStorage(base: string): string | null {
  try {
    const scopedKey = walletStorageKey(base);
    const scoped = localStorage.getItem(scopedKey);
    if (scoped !== null && scoped !== "") return scoped;
    if (walletStorageTomb() !== "personal") return scoped;
    const legacy = localStorage.getItem(base);
    if (legacy === null || legacy === "") return scoped;
    try {
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(base);
    } catch {
      // Quota: still serve the unsuffixed bytes this read.
    }
    return legacy;
  } catch {
    return null;
  }
}
