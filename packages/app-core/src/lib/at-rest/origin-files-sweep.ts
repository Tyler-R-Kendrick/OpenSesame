/**
 * Boot-time purge of origin files that are not sealed under the device key
 * (ADR 0149). Unauthenticated plaintext cannot be hydrated or re-sealed into
 * a trusted envelope. Apart from `origin-files.ts` because only a shell with a
 * directory to list — the Pages boot — runs it.
 */

import { lockManager, originFiles } from "../../ports.js";
import { storageWritesHalted } from "../storage-halt.js";
import { ORIGIN_FILE_PREFIX } from "../storage-ownership.js";
import { AT_REST_PREFIX, isSealedAtRest } from "./cipher.js";
import { atRestReady } from "./key.js";

const SWEEP_LOCK = "opensesame.at-rest.sweep";

/** Whether a file still starts in the clear: five bytes, not the file. */
async function isLegacy(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    const file = await (await root.getFileHandle(name)).getFile();
    return !/^osr[0-9]/u.test(
      await file.slice(0, AT_REST_PREFIX.length).text(),
    );
  } catch {
    return false;
  }
}

async function removeIfUnsealed(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    const handle = await root.getFileHandle(name);
    const text = await (await handle.getFile()).text();
    if (isSealedAtRest(text) || storageWritesHalted()) return false;
    await root.removeEntry(name);
    return true;
  } catch {
    return false;
  }
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
  // Every boot checks, in parallel, only each file's first five bytes: a tab
  // of an older build may have written in the clear since the last boot.
  const legacy = await Promise.all(names.map((name) => isLegacy(root, name)));
  let removed = 0;
  for (const name of names.filter((_, index) => legacy[index])) {
    try {
      if (await removeIfUnsealed(root, name)) removed += 1;
    } catch {
      // Gone, or refused: the next boot tries again.
    }
  }
  return removed;
}

/**
 * Remove every app origin file that is not sealed under the device key. Runs
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
