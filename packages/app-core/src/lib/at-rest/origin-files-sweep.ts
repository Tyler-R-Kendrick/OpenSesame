/**
 * The boot-time sweep that seals origin files an older build left in the
 * clear (ADR 0148). Apart from `origin-files.ts` because only a shell with a
 * directory to list — the Pages boot — runs it.
 */

import { lockManager, maybeLocalStore, originFiles } from "../../ports.js";
import { storageWritesHalted } from "../storage-halt.js";
import { ORIGIN_FILE_PREFIX } from "../storage-ownership.js";
import { AT_REST_PREFIX, isSealedAtRest } from "./cipher.js";
import { type AtRestKey, atRestReady } from "./key.js";
import { sealOriginFile } from "./origin-files.js";

const SWEEP_LOCK = "opensesame.at-rest.sweep";
/**
 * Set once a sweep has found every file sealed, so later boots skip it: from
 * then on only this build writes, and it writes nothing in the clear.
 */
export const SWEPT_KEY = "opensesame.at-rest.swept.v1";

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
  let complete = true;
  for (const name of names) {
    try {
      if (await sealIfLegacy(root, name, atRest)) sealed += 1;
    } catch {
      // Gone, or refused: the next boot tries again.
      complete = false;
    }
  }
  if (complete) maybeLocalStore()?.setItem(SWEPT_KEY, "1");
  return sealed;
}

/**
 * Seal every one of the app's origin files still stored in the clear. Runs
 * at boot, before anything is hydrated or written, under a Web Lock so two
 * tabs booting at once do not both rewrite a file.
 */
export async function sealLegacyOriginFiles(): Promise<number> {
  try {
    if (maybeLocalStore()?.getItem(SWEPT_KEY) === "1") return 0;
    const locks = lockManager();
    if (!locks) return await sweep();
    return await locks.request(SWEEP_LOCK, () => sweep());
  } catch {
    return 0;
  }
}
