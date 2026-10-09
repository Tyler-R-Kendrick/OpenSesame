import { originFiles } from "../ports.js";
import { atRestReady, atRestSettled } from "./at-rest/key.js";
import {
  openOriginFile,
  sealOriginFile,
  sealedFileBound,
} from "./at-rest/origin-files.js";
import { haltedWriteError, storageWritesHalted } from "./storage-halt.js";
import { ORIGIN_FILE_PREFIX } from "./storage-ownership.js";
/**
 * Same-origin KV with OPFS primary + in-memory fallback.
 * Never uses localStorage/sessionStorage (XSS-exfiltrable; banned by ast-grep).
 * Every file's content is sealed under the device's at-rest key, bound to
 * its file name (`at-rest/origin-files.ts`, ADR 0149); with no durable key
 * nothing is written to a file at all.
 *
 * This is the flat transport layer. The encrypted VFS (`lib/vfs.ts`,
 * ADR 0063) builds the tomb namespace on top: every vault is a tomb
 * (`tomb/<name>/…`, the personal vault is the `personal` tomb, ADR 0038),
 * sealed content under the tomb's vault key. What ADR 0063 left outside
 * the vault key (boot endpoints, vault header params, lockout counters,
 * tomb names) is sealed under the device key here like everything else.
 */

const memory = new Map<string, string>();

/**
 * Whether writes can outlive the tab. "unknown" until something touches OPFS —
 * `kvHydrate` settles it before first paint.
 */
export type KvDurability = "unknown" | "persistent" | "memory";

let durability: KvDurability = "unknown";

/**
 * Reported so callers can say plainly that nothing will survive a reload rather
 * than let a successful write imply it was saved.
 */
export function kvDurability(): KvDurability {
  // A key that dies with this document makes every file write pointless.
  if (atRestSettled()?.durable === false) return "memory";
  return durability;
}

async function opfsRoot(
  strict = false,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = (await originFiles()?.()) ?? null;
    durability = root ? "persistent" : "memory";
    return root;
  } catch (error) {
    if (strict) throw error;
    durability = "memory";
    return null;
  }
}

function fileName(key: string): string {
  return `${ORIGIN_FILE_PREFIX}${key.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

/** Origin-file writes and deletes this tab has started and not yet seen land. */
const inFlight = new Set<Promise<unknown>>();

function track<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  const settle = () => {
    inFlight.delete(work);
  };
  work.then(settle, settle);
  return work;
}

/**
 * Wait until every origin-file write or delete this tab has started has
 * landed (or failed), including ones started while waiting. Resetting this
 * browser lists the origin's files only after this, so a write already in
 * the air cannot recreate a file the reset has just removed.
 */
export async function kvFlush(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/**
 * The origin file a key is stored in. Travel mode (ADR 0143) moves a vault
 * at this layer — every file of a tomb, including ones no module hydrated —
 * so it needs the storage layer's own name for a key.
 */
export function kvFileName(key: string): string {
  return fileName(key);
}

/**
 * Drop every in-memory copy. Resetting this browser does, once the files
 * are gone, so nothing read afterwards — the tomb registry, a vault header —
 * describes storage that no longer exists.
 */
export function kvForgetAll(): void {
  memory.clear();
  unreadable.clear();
}

/** Drop every in-memory copy whose origin file is in `files` (already removed). */
export function kvForgetFiles(files: ReadonlySet<string>): void {
  for (const key of [...memory.keys(), ...unreadable]) {
    if (!files.has(fileName(key))) continue;
    memory.delete(key);
    unreadable.delete(key);
  }
}

/**
 * Keys whose file is sealed under a key this device does not hold. Nothing
 * writes over one: the app reads it as absent, and a first run must not put a
 * new vault where an old one still lies (ADR 0149).
 */
const unreadable = new Set<string>();

async function opfsRead(key: string): Promise<string | null> {
  try {
    const root = await opfsRoot();
    if (!root) return null;
    const name = fileName(key);
    const handle = await root.getFileHandle(name);
    const file = await handle.getFile();
    const opened = await openOriginFile(name, await file.text());
    if (opened === null) unreadable.add(key);
    return opened;
  } catch {
    return null;
  }
}

async function opfsWriteNow(
  key: string,
  value: string,
  beforeCommit?: () => void,
): Promise<void> {
  const atRest = await atRestReady();
  // No durable key: memory is all there is, and nothing reaches a file.
  if (!atRest.durable) {
    beforeCommit?.();
    return;
  }
  if (unreadable.has(key)) {
    throw new Error("refusing to overwrite a file sealed under another key");
  }
  const root = await opfsRoot(true);
  if (!root) {
    beforeCommit?.();
    return;
  }
  const name = fileName(key);
  const sealed = sealOriginFile(atRest, name, value);
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(sealed);
    beforeCommit?.();
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

function opfsWrite(
  key: string,
  value: string,
  beforeCommit?: () => void,
): Promise<void> {
  // Refused before it starts, so nothing is in flight to wait for.
  if (storageWritesHalted()) return Promise.reject(haltedWriteError());
  return track(opfsWriteNow(key, value, beforeCommit));
}

/** Sync read from hydrated memory. */
function kvGetDefault(key: string): string | null {
  return memory.get(key) ?? null;
}

/**
 * Sync write to memory; async persist to OPFS when available. Failures are
 * swallowed: memory is the source of truth for the session. Use `kvSetDurable`
 * wherever losing the write would mean losing the only copy of something.
 */
export function kvSet(key: string, value: string): void {
  memory.set(key, value);
  void opfsWrite(key, value).catch(() => {
    /* memory remains source of truth for the session */
  });
}

/**
 * Write to memory and wait for OPFS to accept it, rejecting if it does not, so
 * the caller can undo its change rather than believe it was saved. Memory is
 * left holding the previous value on failure, matching what survives a reload.
 *
 * Where OPFS is absent altogether this resolves — refusing would leave the app
 * unusable in that browser. `kvDurability()` reports which case you are in, and
 * the vault says so on screen.
 */
async function kvSetDurableDefault(
  key: string,
  value: string,
  beforeCommit?: () => void,
): Promise<void> {
  await opfsWrite(key, value, beforeCommit);
  memory.set(key, value);
}

export const kvSeams = {
  kvGet: kvGetDefault,
  kvSetDurable: kvSetDurableDefault,
  kvHydrate: (keys: string[]) => kvHydrateDefault(keys),
};

export function kvGet(key: string): string | null {
  return kvSeams.kvGet(key);
}

export async function kvSetDurable(
  key: string,
  value: string,
  beforeCommit?: () => void,
): Promise<void> {
  return kvSeams.kvSetDurable(key, value, beforeCommit);
}

export function kvDelete(key: string): void {
  memory.delete(key);
  unreadable.delete(key);
  void track(
    (async () => {
      try {
        const root = await opfsRoot();
        if (!root) return;
        await root.removeEntry(fileName(key));
      } catch {
        /* ignore */
      }
    })(),
  );
}

/**
 * Remove a key and wait for OPFS to forget it, so a caller can tell the user it
 * is gone rather than that it has been asked to go. Absent already counts as
 * gone; anything else is reported.
 */
export async function kvDeleteDurable(key: string): Promise<void> {
  memory.delete(key);
  unreadable.delete(key);
  const root = await opfsRoot();
  if (!root) return;
  try {
    await root.removeEntry(fileName(key));
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    // Restricted OPFS (CI Chrome / sandboxed profiles) refuses mutation; memory
    // already dropped the key, so treat as session-only storage.
    if (
      error instanceof DOMException &&
      (error.name === "NoModificationAllowedError" ||
        error.name === "SecurityError")
    ) {
      durability = "memory";
      return;
    }
    throw error;
  }
}

/** Load keys from OPFS into memory before first paint. */
export async function kvHydrate(keys: string[]): Promise<void> {
  return kvSeams.kvHydrate(keys);
}

async function kvHydrateDefault(keys: string[]): Promise<void> {
  // Settle durability even with nothing to load, so the first render already
  // knows whether anything written here can survive a reload.
  await opfsRoot();
  await Promise.all(
    keys.map(async (key) => {
      const value = await opfsRead(key);
      if (value != null) memory.set(key, value);
    }),
  );
}

/** Refresh a security record without treating storage failure as absence.
 * Call under the record's Web Lock before evaluating or changing authority.
 * Browsers without OPFS retain explicitly session-only storage.
 */
export async function kvRefresh(key: string, maxBytes: number): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new Error("Invalid storage read limit");
  const openRoot = originFiles();
  if (!openRoot) {
    durability = "memory";
    return;
  }
  try {
    const root = await openRoot();
    durability = "persistent";
    let handle: FileSystemFileHandle;
    try {
      handle = await root.getFileHandle(fileName(key));
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") {
        memory.delete(key);
        return;
      }
      throw error;
    }
    const file = await handle.getFile();
    if (file.size > sealedFileBound(maxBytes))
      throw new Error("Storage record exceeds read limit");
    const value = await openOriginFile(fileName(key), await file.text());
    if (value === null) throw new Error("Storage record does not open");
    if (new TextEncoder().encode(value).length > maxBytes)
      throw new Error("Storage record exceeds read limit");
    memory.set(key, value);
  } catch (error) {
    // No later sync reader may consume an authority snapshot we failed to refresh.
    memory.delete(key);
    throw error;
  }
}
