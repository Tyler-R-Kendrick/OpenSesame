/**
 * Web Storage, sealed (ADR 0149). Every value written through the ports'
 * `local` and `session` stores reaches `localStorage` / `sessionStorage` as
 * an at-rest seal bound to its area and key; the app reads plaintext back.
 * Key names stay readable — they are what "Reset this browser" removes by
 * (`storage-ownership.ts`) — values never are.
 *
 * Unsealed bytes under an app-owned key are never trusted: they are removed
 * on read and at boot (`sealLegacyWebStorage`) rather than re-sealed into a
 * device envelope an attacker could plant in the clear (ADR 0149).
 */

import { host } from "../../host.js";
import type { WebStorage } from "../../ports.js";
import { storageWritesHalted } from "../storage-halt.js";
import {
  type WebStorageArea,
  ownsWebStorageKey,
} from "../storage-ownership.js";
import {
  atRestBinding,
  isSealedAtRest,
  openAtRest,
  sealAtRest,
} from "./cipher.js";
import { type AtRestKey, atRestKeyNow, onAtRestReady } from "./key.js";

/**
 * Values held in memory instead of on disk, per area: writes made before
 * the key loaded (flushed, sealed, when it does), and every write while the
 * key is ephemeral (never flushed).
 */
const held = {
  local: new Map<string, string>(),
  session: new Map<string, string>(),
} satisfies Record<WebStorageArea, Map<string, string>>;

/** A sealed value was read before the device key loaded. */
export class AtRestKeyPendingError extends Error {
  constructor(key: string) {
    super(`at-rest key not loaded yet; cannot read "${key}"`);
    this.name = "AtRestKeyPendingError";
  }
}

function binding(area: WebStorageArea, key: string): Uint8Array {
  return atRestBinding(`web-storage.${area}`, key);
}

function writeSealed(
  store: WebStorage,
  area: WebStorageArea,
  atRest: AtRestKey,
  key: string,
  value: string,
): void {
  if (storageWritesHalted()) return;
  store.setItem(key, sealAtRest(atRest.key, binding(area, key), value));
}

function flushHeld(
  store: WebStorage,
  area: WebStorageArea,
  atRest: AtRestKey,
): void {
  if (!atRest.durable) return;
  const pending = held[area];
  for (const [key, value] of [...pending]) {
    try {
      writeSealed(store, area, atRest, key, value);
      pending.delete(key);
    } catch {
      // Refused (a full quota): it stays in memory rather than be lost.
    }
  }
}

function read(
  store: WebStorage,
  area: WebStorageArea,
  key: string,
): string | null {
  const pending = held[area];
  if (pending.has(key)) return pending.get(key) ?? null;
  const raw = store.getItem(key);
  if (raw === null) return null;
  const atRest = atRestKeyNow();
  if (!isSealedAtRest(raw)) {
    // Another writer's key is theirs to read raw; ours must open as a seal.
    if (ownsWebStorageKey(key, area)) {
      if (!storageWritesHalted()) store.removeItem(key);
      return null;
    }
    return raw;
  }
  if (!atRest) throw new AtRestKeyPendingError(key);
  return openAtRest(atRest.key, binding(area, key), raw);
}

function write(
  store: WebStorage,
  area: WebStorageArea,
  key: string,
  value: string,
): void {
  const atRest = atRestKeyNow();
  if (!atRest?.durable) {
    held[area].set(key, value);
    if (!atRest) {
      onAtRestReady((settled) => flushHeld(store, area, settled));
    }
    return;
  }
  writeSealed(store, area, atRest, key, value);
  held[area].delete(key);
}

/** `store`, with every value sealed on the way in and opened on the way out. */
export function sealedWebStorage(
  store: WebStorage,
  area: WebStorageArea,
): WebStorage {
  return {
    get length() {
      return store.length;
    },
    key: (index) => store.key(index),
    getItem: (key) => read(store, area, key),
    setItem: (key, value) => write(store, area, key, value),
    removeItem(key) {
      held[area].delete(key);
      store.removeItem(key);
    },
  };
}

/**
 * Remove every app-owned key still stored in the clear, in the host's own
 * store for `area` (never the ports' sealed view of it, which would not
 * return plaintext). Keys another writer owns are left as they are.
 */
export function sealLegacyWebStorage(area: WebStorageArea): number {
  const store = host().storage?.[area];
  if (!store || storageWritesHalted()) return 0;
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key !== null && ownsWebStorageKey(key, area)) keys.push(key);
  }
  let removed = 0;
  for (const key of keys) {
    const raw = store.getItem(key);
    if (raw === null || isSealedAtRest(raw)) continue;
    store.removeItem(key);
    removed += 1;
  }
  return removed;
}

/** Drop held values (tests). */
export function forgetHeldWebStorageForTest(): void {
  held.local.clear();
  held.session.clear();
}
