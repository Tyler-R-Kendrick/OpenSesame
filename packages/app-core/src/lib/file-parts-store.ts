/**
 * Origin private files hold encrypted file parts. Reset this browser owns
 * the directory name.
 */

import type { ObjectStore } from "@opensesame/vault-core";
import { originFiles } from "../ports.js";
import { FILE_PARTS_DIRECTORY } from "./storage-ownership.js";

function partName(key: string): string {
  if (!/^[A-Za-z0-9_-]{16}$/.test(key)) throw new Error("file part is missing");
  return key;
}

async function directory() {
  const open = originFiles();
  if (open === undefined) throw new Error("file needs a store");
  const root = await open();
  return root.getDirectoryHandle(FILE_PARTS_DIRECTORY, { create: true });
}

/**
 * Stores beyond this browser's own, each given the local one to keep what it
 * fetches: a paired tailnet drive registers one while sync runs (ADR 0144).
 */
export type FileStoreSource = (local: ObjectStore) => readonly ObjectStore[];

const sources = new Set<FileStoreSource>();

export function addFileStoreSource(source: FileStoreSource): () => void {
  sources.add(source);
  return () => sources.delete(source);
}

/** This browser's own parts, first in every list; a read tries it first. */
export async function defaultFileStores(): Promise<readonly ObjectStore[]> {
  const local = await localFileStore();
  return [local, ...[...sources].flatMap((source) => source(local))];
}

/** Where this browser keeps parts; throws where it has no private files. */
export async function localFileStore(): Promise<ObjectStore> {
  const dir = await directory();
  return {
    async putObject(key, body) {
      const handle = await dir.getFileHandle(partName(key), { create: true });
      const writable = await handle.createWritable();
      await writable.write(body);
      await writable.close();
    },
    async getObject(key) {
      try {
        const handle = await dir.getFileHandle(partName(key));
        const file = await handle.getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch (error) {
        if (error instanceof DOMException && error.name === "NotFoundError")
          return null;
        throw error;
      }
    },
  };
}
