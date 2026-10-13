/** Bounded original fixed-entry origin reads and cleanup of an owned empty placeholder. */
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
import { isSealedAtRest } from "./at-rest/cipher.js";
import { openOriginFile, sealedFileBound } from "./at-rest/origin-files.js";
import {
  type OriginalOriginFileData,
  captureOriginalOriginDirectoryData,
  captureOriginalOriginFileData,
} from "./origin-file-publication-fixed-receiver-data.js";
export type OriginRecord = {
  handle: FileSystemFileHandle | null;
  value: string | null;
  entry: OriginalOriginFileData | null;
  /** Original physical ciphertext DATA for inventory evidence; never owner authority. */
  ciphertext?: string;
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
  original: () => void,
  requireDeviceSeal = false,
): Promise<OriginRecord> {
  // Snapshot actual receivers before any caller callback at each delivered resource.
  const directory = captureOriginalOriginDirectoryData(root);
  let entry: OriginalOriginFileData | null = null;
  const check = () => {
    original();
    directory.check();
    entry?.check();
  };
  check();
  let handle: FileSystemFileHandle;
  try {
    handle = await directory.get(name);
    entry = captureOriginalOriginFileData(handle);
    check();
  } catch (error) {
    check();
    if (error instanceof DOMException && error.name === "NotFoundError")
      return { handle: null, value: null, entry: null };
    throw error;
  }
  const file = await entry.get();
  const textMethod = file.text;
  const fixedText: typeof textMethod = bindOriginal(textMethod, file);
  const size = file.size;
  const current = () => {
    check();
    if (file.text !== textMethod || file.size !== size)
      throw new Error("Original origin file readback changed.");
  };
  current();
  if (size > sealedFileBound(maxBytes))
    throw new Error("Storage record exceeds read limit.");
  const text = await fixedText();
  current();
  if (new TextEncoder().encode(text).length > sealedFileBound(maxBytes))
    throw new Error("Storage record exceeds read limit.");
  if (requireDeviceSeal && !isSealedAtRest(text))
    throw new Error("Original device record is not sealed.");
  const value = await openOriginFile(name, text);
  current();
  if (value === null) throw new Error("Storage record does not open.");
  checkPublicationLimit(value, maxBytes);
  return { handle, value, entry, ciphertext: text };
}
/** Caller retains original locks; fixed cleanup never deletes a changed entry. */
export async function removeOwnEmptyPlaceholder(
  root: FileSystemDirectoryHandle,
  name: string,
  created: FileSystemFileHandle,
  directory = captureOriginalOriginDirectoryData(root),
  owned = captureOriginalOriginFileData(created),
): Promise<void> {
  const check = () => {
    directory.check();
    owned.check();
  };
  check();
  let current: FileSystemFileHandle;
  let entry: OriginalOriginFileData;
  try {
    current = await directory.get(name);
    entry = captureOriginalOriginFileData(current);
    check();
    entry.check();
  } catch (error) {
    check();
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
  const same = await owned.same(current);
  check();
  entry.check();
  if (!same) return;
  const file = await entry.get();
  const size = file.size;
  check();
  entry.check();
  if (size !== 0) return;
  await directory.remove(name);
  check();
  entry.check();
}
