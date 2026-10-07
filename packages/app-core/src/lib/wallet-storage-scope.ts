/**
 * Wallet localStorage must follow the active vault tomb so a guest
 * cannot read or close the personal ledger.
 */

import { localStore } from "../ports.js";
import {
  assertNotDecoySession,
  currentRealmGeneration,
  isRealAuthorityBlocked,
} from "./decoy-session.js";
import { vaultStore } from "./vault/store.js";

let override: string | null = null;
let lastTomb = "personal";
let epoch = 0;
let realm = -1;
let restricted = false;
const listeners = new Set<() => void>();

function notifyIfChanged(id: string): string {
  if (id !== lastTomb) {
    lastTomb = id;
    epoch += 1;
    for (const listener of listeners) listener();
  }
  return id;
}

/**
 * A number that moves whenever the active tomb changes. A cache that
 * records it beside its rows misses after any switch — including a switch
 * away and straight back, which a tomb name alone cannot tell from no
 * switch at all — whether or not anything was subscribed at the time. So
 * `wallet.spending` being disabled can never leave one tomb's rows
 * answering for another.
 */
export function walletStorageScope(): number {
  walletStorageTomb();
  const nextRealm = currentRealmGeneration();
  const nextRestricted = isRealAuthorityBlocked();
  if (realm !== nextRealm || restricted !== nextRestricted) {
    realm = nextRealm;
    restricted = nextRestricted;
    epoch += 1;
  }
  return epoch;
}

/** A retained wallet handle cannot act in a successor realm or tomb. */
export function assertWalletStorageMutation(expectedScope?: number): void {
  assertNotDecoySession();
  if (expectedScope !== undefined && expectedScope !== walletStorageScope())
    throw new Error("Wallet session changed. Acquire a new owner handle.");
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
  assertWalletStorageMutation();
  return `${base}.${walletStorageTomb()}`;
}

/** Personal-scope fallback: unsuffixed keys from before tomb scoping. */
export function readWalletStorage(base: string): string | null {
  if (isRealAuthorityBlocked()) return null;
  try {
    const scopedKey = walletStorageKey(base);
    const scoped = localStore().getItem(scopedKey);
    if (scoped !== null && scoped !== "") return scoped;
    if (walletStorageTomb() !== "personal") return scoped;
    const legacy = localStore().getItem(base);
    if (legacy === null || legacy === "") return scoped;
    try {
      localStore().setItem(scopedKey, legacy);
      localStore().removeItem(base);
    } catch {
      // Quota: still serve the unsuffixed bytes this read.
    }
    return legacy;
  } catch {
    return null;
  }
}
