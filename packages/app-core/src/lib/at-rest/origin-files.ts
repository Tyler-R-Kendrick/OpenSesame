/**
 * Origin-private files, sealed (ADR 0148). `kv.ts` and travel
 * (`travel/storage.ts`) write every `opensesame-pages-*.json` file as an
 * at-rest seal bound to its file name, and read the plaintext back. The
 * binding is the file name, not the key, because travel moves files by name.
 *
 * The vault's own ciphertext is sealed twice — once under the vault key, once
 * under this — and what used to be the documented plaintext boundary (vault
 * header parameters, lockout counters, the tomb registry) is sealed once.
 */

import { lockManager, originFiles } from "../../ports.js";
import { storageWritesHalted } from "../storage-halt.js";
import { ORIGIN_FILE_PREFIX } from "../storage-ownership.js";
import {
  AT_REST_PREFIX,
  atRestBinding,
  isSealedAtRest,
  openAtRest,
  sealAtRest,
} from "./cipher.js";
import { type AtRestKey, atRestReady } from "./key.js";

const SWEEP_LOCK = "opensesame.at-rest.sweep";

function binding(name: string): Uint8Array {
  return atRestBinding("origin-file", name);
}

export function sealOriginFile(
  atRest: AtRestKey,
  name: string,
  value: string,
): string {
  return sealAtRest(atRest.key, binding(name), value);
}

/**
 * A file's plaintext. A file written before values were sealed reads as it
 * is (`sealLegacyOriginFiles` seals it at the next boot); a sealed file that
 * does not open under this device's key reads as null.
 */
export async function openOriginFile(
  name: string,
  text: string,
): Promise<string | null> {
  if (!isSealedAtRest(text)) return text;
  const atRest = await atRestReady();
  return openAtRest(atRest.key, binding(name), text);
}

/** The largest sealed file a plaintext of `maxBytes` bytes can become. */
export function sealedFileBound(maxBytes: number): number {
  return AT_REST_PREFIX.length + Math.ceil(((maxBytes + 40) * 4) / 3) + 4;
}

async function sealIfLegacy(
  root: FileSystemDirectoryHandle,
  name: string,
  atRest: AtRestKey,
): Promise<boolean> {
  const handle = await root.getFileHandle(name);
  const file = await handle.getFile();
  const head = await file.slice(0, AT_REST_PREFIX.length).text();
  if (head === AT_REST_PREFIX) return false;
  const text = await file.text();
  if (isSealedAtRest(text) || storageWritesHalted()) return false;
  const writable = await handle.createWritable();
  await writable.write(sealOriginFile(atRest, name, text));
  await writable.close();
  return true;
}

async function sweep(): Promise<number> {
  const atRest = await atRestReady();
  const open = originFiles();
  if (!atRest.durable || !open) return 0;
  const root = await open();
  const names: string[] = [];
  for await (const name of root.keys()) {
    if (name.startsWith(ORIGIN_FILE_PREFIX)) names.push(name);
  }
  let sealed = 0;
  for (const name of names) {
    try {
      if (await sealIfLegacy(root, name, atRest)) sealed += 1;
    } catch {
      // Gone, or refused: the next boot tries again.
    }
  }
  return sealed;
}

/**
 * Seal every one of the app's origin files still stored in the clear. Runs
 * at boot, before anything is hydrated or written, under a Web Lock so two
 * tabs booting at once do not both rewrite a file.
 */
export async function sealLegacyOriginFiles(): Promise<number> {
  try {
    const locks = lockManager();
    if (!locks) return await sweep();
    return await locks.request(SWEEP_LOCK, () => sweep());
  } catch {
    return 0;
  }
}
