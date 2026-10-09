/** Bounded actual origin-file reads and cleanup of an owned empty placeholder. */
import { isSealedAtRest } from "./at-rest/cipher.js";
import { openOriginFile, sealedFileBound } from "./at-rest/origin-files.js";

export type OriginRecord = {
  handle: FileSystemFileHandle | null;
  value: string | null;
};

export function checkPublicationLimit(value: string, maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > 16 * 1024 * 1024 ||
    new TextEncoder().encode(value).length > maxBytes
  ) {
    throw new Error("Invalid guarded storage publication limit.");
  }
}

export async function readOriginRecord(
  root: FileSystemDirectoryHandle,
  name: string,
  maxBytes: number,
  check: () => void,
  requireDeviceSeal = false,
): Promise<OriginRecord> {
  check();
  let handle: FileSystemFileHandle;
  try {
    handle = await root.getFileHandle(name);
    check();
  } catch (error) {
    check();
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return { handle: null, value: null };
    }
    throw error;
  }
  const file = await handle.getFile();
  check();
  if (file.size > sealedFileBound(maxBytes)) {
    throw new Error("Storage record exceeds read limit.");
  }
  const text = await file.text();
  check();
  if (new TextEncoder().encode(text).length > sealedFileBound(maxBytes)) {
    throw new Error("Storage record exceeds read limit.");
  }
  if (requireDeviceSeal && !isSealedAtRest(text)) {
    throw new Error("Original device record is not sealed.");
  }
  const value = await openOriginFile(name, text);
  check();
  if (value === null) throw new Error("Storage record does not open.");
  checkPublicationLimit(value, maxBytes);
  return { handle, value };
}

/** Caller still holds the original record locks; never delete a changed entry. */
export async function removeOwnEmptyPlaceholder(
  root: FileSystemDirectoryHandle,
  name: string,
  created: FileSystemFileHandle,
): Promise<void> {
  let current: FileSystemFileHandle;
  try {
    current = await root.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  if (!(await created.isSameEntry(current))) return;
  if ((await current.getFile()).size !== 0) return;
  await root.removeEntry(name);
}
