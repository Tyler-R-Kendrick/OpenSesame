/**
 * The test hosts' record of every Web Storage write the core makes through
 * its ports (`ports.ts`), and the check each test setup runs after every
 * test: a key the app does not own (`lib/storage-ownership.ts`) fails the
 * test that wrote it. A caller's own try/catch cannot hide it, so a new key
 * cannot reach a release without its ownership rule — and without "Reset
 * this browser" removing it.
 */

import {
  type WebStorageArea,
  ownsWebStorageKey,
} from "./lib/storage-ownership.js";

type StorageWrite = Readonly<{ area: WebStorageArea; key: string }>;

const writes: StorageWrite[] = [];

export function recordStorageWrite(area: WebStorageArea, key: string): void {
  writes.push({ area, key });
}

/** Every write since the last call, which it forgets. */
export function takeStorageWrites(): StorageWrite[] {
  return writes.splice(0);
}

/** Throw when any write since the last check named a key the app does not own. */
export function assertOwnedStorageWrites(): void {
  const unowned = takeStorageWrites().filter(
    ({ area, key }) => !ownsWebStorageKey(key, area),
  );
  if (unowned.length === 0) return;
  const named = unowned.map(({ area, key }) => `${area}:${key}`).join(", ");
  throw new Error(
    `wrote Web Storage keys the app does not own (lib/storage-ownership.ts): ${named}`,
  );
}
