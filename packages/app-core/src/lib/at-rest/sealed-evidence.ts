/**
 * Whether this device already holds values sealed at rest (ADR 0148) — that
 * is, whether a key existed here before.
 *
 * The browser mints a key only when nothing is sealed yet. A device whose key
 * record is gone while its seals remain (IndexedDB cleared alone, a failed
 * partial reset) must not mint a new one: the app would read its vault as
 * absent and could write a new one over the old files. It runs ephemeral
 * instead — nothing written, nothing overwritten — and the seals stay on disk
 * for the day the key comes back.
 */

import { host } from "../../host.js";
import { originFiles } from "../../ports.js";
import { ORIGIN_FILE_PREFIX, ownsWebStorageKey } from "../storage-ownership.js";
import { AT_REST_PREFIX, isSealedAtRest } from "./cipher.js";

function webStorageHoldsSeals(): boolean {
  for (const area of ["local", "session"] as const) {
    const store = host().storage?.[area];
    if (!store) continue;
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key === null || !ownsWebStorageKey(key, area)) continue;
      if (isSealedAtRest(store.getItem(key) ?? "")) return true;
    }
  }
  return false;
}

async function originFilesHoldSeals(): Promise<boolean> {
  const open = originFiles();
  if (!open) return false;
  const root = await open();
  for await (const [name, handle] of root.entries()) {
    if (!name.startsWith(ORIGIN_FILE_PREFIX) || handle.kind !== "file") {
      continue;
    }
    const file = await root.getFileHandle(name).then((h) => h.getFile());
    const head = await file.slice(0, AT_REST_PREFIX.length).text();
    if (head === AT_REST_PREFIX) return true;
  }
  return false;
}

export async function deviceHoldsSeals(): Promise<boolean> {
  return webStorageHoldsSeals() || (await originFilesHoldSeals());
}
