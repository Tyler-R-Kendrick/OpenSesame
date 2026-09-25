/**
 * Where a vault lives in this origin's storage, file by file (ADR 0143).
 *
 * A vault is more than its body: its tomb holds the header, the sealed index
 * and a config file per module, and a few plaintext records (the lockout
 * counter, site-broker consents, an offline ciphertext cache) sit beside it
 * under keys named for it. Travel moves all of them, found by the storage
 * layer's own file names rather than by a list of modules that would go
 * stale the day someone adds a config file.
 *
 * Tomb names nest by prefix (`tomb_personal_…` would also start a tomb named
 * `personal_x`), so a file belongs to the longest tomb stem it starts with.
 */

import { originFiles } from "../../ports.js";
import { kvDurability, kvFileName, kvForgetFiles } from "../kv.js";
import { projectScopedKeys } from "../projects.js";
import { listTombs, registerTomb, unregisterTomb } from "../vfs.js";
import type { VaultNamespace } from "./bundle-format.js";

/** Tombs that exist on some device but are never a vault that travels. */
const SESSION_TOMBS = ["guest", "guest-scratch"] as const;
const OFFLINE_CACHE_PREFIX = "vault.offline-ciphertext.v1:";

export type TravelStorage = {
  /** False when nothing written here outlives the tab. */
  durable(): boolean;
  /** Every origin file name. */
  listFiles(): Promise<string[]>;
  read(file: string): Promise<string | null>;
  write(file: string, text: string): Promise<void>;
  remove(file: string): Promise<void>;
  /** Drop in-memory copies of files that were just removed. */
  forget(files: ReadonlySet<string>): void;
  tombs(): string[];
  registerTomb(tomb: string): Promise<void>;
  unregisterTomb(tomb: string): Promise<void>;
};

/** `opensesame-pages-tomb_<id>_` — the start of every file in a tomb. */
export function tombStem(id: string): string {
  return kvFileName(`tomb/${id}/`).replace(/\.json$/, "");
}

/** The plaintext records named for a vault, as origin file names. */
export function scopedFiles(id: string): Set<string> {
  const keys = [...projectScopedKeys(id), `${OFFLINE_CACHE_PREFIX}${id}`];
  if (id === "personal") keys.push(`${OFFLINE_CACHE_PREFIX}_default`);
  return new Set(keys.map(kvFileName));
}

/** The tomb a file belongs to, by longest stem, among `ids`. */
export function tombOwning(
  file: string,
  ids: readonly string[],
): string | null {
  let owner: string | null = null;
  let longest = 0;
  for (const id of ids) {
    const stem = tombStem(id);
    if (file.startsWith(stem) && stem.length > longest) {
      owner = id;
      longest = stem.length;
    }
  }
  return owner;
}

/**
 * The namespace check a bundle's files must pass on the way back in: a file
 * is one of this vault's plaintext records, or sits in its tomb and in no
 * longer-named tomb this device knows.
 */
export function vaultNamespace(knownTombs: readonly string[]): VaultNamespace {
  return (id, file) => {
    if (!/^opensesame-pages-[A-Za-z0-9._-]+\.json$/.test(file)) return false;
    if (scopedFiles(id).has(file)) return true;
    const ids = [...new Set([...knownTombs, ...SESSION_TOMBS, id])];
    return tombOwning(file, ids) === id;
  };
}

/** Every file of `id` present in `files`. */
export function filesOfVault(
  id: string,
  files: readonly string[],
  knownTombs: readonly string[],
): string[] {
  const owns = vaultNamespace(knownTombs);
  return files.filter((file) => owns(id, file)).sort();
}

async function root(): Promise<FileSystemDirectoryHandle> {
  const open = originFiles();
  if (!open) throw new Error("This browser keeps no files for this site.");
  return open();
}

/** The origin's own storage: OPFS, the same files `kv.ts` writes. */
export const originTravelStorage: TravelStorage = {
  durable: () => kvDurability() === "persistent",
  async listFiles() {
    const names: string[] = [];
    for await (const name of (await root()).keys()) names.push(name);
    return names;
  },
  async read(file) {
    try {
      const handle = await (await root()).getFileHandle(file);
      return await (await handle.getFile()).text();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return null;
      }
      throw error;
    }
  },
  async write(file, text) {
    const handle = await (await root()).getFileHandle(file, { create: true });
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  },
  async remove(file) {
    try {
      await (await root()).removeEntry(file);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        return;
      }
      throw error;
    }
  },
  forget: kvForgetFiles,
  tombs: listTombs,
  registerTomb,
  unregisterTomb,
};
