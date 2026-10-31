import {
  type SealedBlob,
  assertSealed,
  bytesToB64,
  vaultSealBinding,
} from "@opensesame/vault-core";
import {
  type SealedFileEnvelope,
  type TombsRegistry,
  assertFilePath,
  assertTombName,
  parseEnvelope,
  parseRegistry,
  parseSealedBlob,
} from "./vfs-metadata-data.js";
import { originalVfsCheck } from "./vfs-operation-check.js";
import { INDEX_PATH, readIndex, reviseIndex } from "./vfs-sealed-index.js";
import { vfsSeams } from "./vfs-seams.js";
import { type TombWriteTurn, enqueueTombWrite } from "./vfs-write-order.js";
export { vfsFlush } from "./vfs-write-order.js";

/**
 * Encrypted VFS (ADR 0063). AES-GCM seals bind tomb and path as additional
 * data. Plaintext is tomb names, headers and migration markers. Storage is OPFS.
 */

import {
  VFS_REGISTRY_LOCK,
  withVfsCrossTabLock,
} from "./vfs-cross-tab-lock.js";
import { VfsError } from "./vfs-error.js";
export { VfsError, type VfsErrorCode } from "./vfs-error.js";

export const PERSONAL_TOMB = "personal"; // same as the personal project id
/** Isolated guest session tomb — never a project in the vault list. */
export const GUEST_TOMB = "guest";

/** Plaintext top-level registry key — tomb names only, never contents. */
export const TOMBS_REGISTRY_KEY = "tombs.v1";

export const HEADER_PATH = "header";
export const BODY_PATH = "body";
export { INDEX_PATH } from "./vfs-sealed-index.js";
/** Idempotent legacy-migration marker (plaintext; names, not contents). */
export const MIGRATION_MARKER_PATH = "migrated.v1";
/** Written after unlock rewrites every seal with a path binding. */
export const SEAL_BOUND_MARKER_PATH = "seal-bound.v1";

export { type VfsSeams, vfsSeams } from "./vfs-seams.js";

/* ------------------------------------------------------------- tomb keys */

/** Session vault key for one tomb. Dropped on lock; sealed I/O then fails locked. */
const tombKeys = new Map<string, CryptoKey>();

export function unlockTomb(tomb: string, key: CryptoKey): void {
  assertTombName(tomb);
  tombKeys.set(tomb, key);
}

export function lockTomb(tomb: string): void {
  tombKeys.delete(tomb);
}

export function lockAllTombs(): void {
  tombKeys.clear();
}

export function tombUnlocked(tomb: string): boolean {
  return tombKeys.has(tomb);
}

function requireTombKey(tomb: string): CryptoKey {
  const key = tombKeys.get(tomb);
  if (!key) {
    throw new VfsError(
      "locked",
      `Tomb "${tomb}" is locked — unlock its vault before reading or writing sealed files.`,
    );
  }
  return key;
}

/* ------------------------------------------------------------------ paths */

/** kv transport key for a logical VFS path. */
export function tombFileKey(tomb: string, path: string): string {
  assertTombName(tomb);
  assertFilePath(path);
  return `tomb/${tomb}/${path}`;
}

function assertSealedPath(path: string): void {
  if (path === INDEX_PATH) {
    throw new VfsError(
      "invalid-path",
      "The tomb index is maintained by the VFS itself.",
    );
  }
  if (
    path === HEADER_PATH ||
    path === MIGRATION_MARKER_PATH ||
    path === SEAL_BOUND_MARKER_PATH
  ) {
    throw new VfsError(
      "invalid-path",
      `"${path}" is a plaintext file — use the plaintext helpers.`,
    );
  }
}

/* --------------------------------------------------------------- registry */

function readRegistry(): string[] {
  return parseRegistry(vfsSeams.readRaw(TOMBS_REGISTRY_KEY));
}

async function writeRegistry(
  names: string[],
  check: () => void = () => {},
  commit: (storageKey: string, value: string) => Promise<void> = (
    storageKey,
    value,
  ) => vfsSeams.writeRaw(storageKey, value),
): Promise<void> {
  check();
  const registry: TombsRegistry = {
    v: 1,
    tombs: [...new Set(names)].sort(),
  };
  await commit(TOMBS_REGISTRY_KEY, JSON.stringify(registry));
  check();
}

/**
 * Every tomb on this device, by name. Plaintext by design (the `tombs.json`
 * analog — names are not secrets). Sync because the registry hydrates with
 * the rest of the boot keys.
 */
export function listTombs(): string[] {
  return readRegistry();
}

/** Add a tomb to the registry. Idempotent; every tomb write ensures this. */
export async function registerTomb(
  tomb: string,
  check: () => void = () => {},
  commit?: (storageKey: string, value: string) => Promise<void>,
): Promise<void> {
  check();
  assertTombName(tomb);
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    check();
    const names = readRegistry();
    if (names.includes(tomb)) return;
    await writeRegistry([...names, tomb], check, commit);
  });
}

export async function unregisterTomb(tomb: string): Promise<void> {
  await withVfsCrossTabLock(VFS_REGISTRY_LOCK, async () => {
    const names = readRegistry();
    if (!names.includes(tomb)) return;
    await writeRegistry(names.filter((name) => name !== tomb));
  });
}

/* ------------------------------------------------------------------ index */

/* ------------------------------------------------------------------ blobs */

/* -------------------------------------------------------------- plaintext */

/**
 * Read a plaintext tomb file (header params, migration marker). Sync: the
 * boot path hydrates these keys before first paint, exactly like the legacy
 * header key. Plaintext here is the documented ADR 0063 boundary — public
 * parameters, never vault content.
 */
export function readPlaintextFile(tomb: string, path: string): string | null {
  return vfsSeams.readRaw(tombFileKey(tomb, path));
}

export async function writePlaintextFile(
  tomb: string,
  path: string,
  text: string,
  check?: () => void,
): Promise<void> {
  const active = originalVfsCheck(check);
  await vfsSeams.writeRaw(tombFileKey(tomb, path), text);
  active();
  await registerTomb(tomb, active);
  active();
}

export async function deletePlaintextFile(
  tomb: string,
  path: string,
): Promise<void> {
  await vfsSeams.deleteRaw(tombFileKey(tomb, path));
}

/* ------------------------------------------------------------ sealed files */

/**
 * Seal `bytes` under the tomb's vault key and store them, then bump the
 * file's revision in the sealed index. Requires an unlocked tomb.
 */
export async function writeFile(
  tomb: string,
  path: string,
  bytes: Uint8Array,
  check?: () => void,
): Promise<void> {
  assertSealedPath(path);
  const operation = originalVfsCheck(check);
  const originalKey = check ? requireTombKey(tomb) : null;
  const guarded = vfsSeams.writeRawGuarded;
  if (check && !guarded)
    throw new VfsError(
      "locked",
      "This storage cannot commit an original-owner write.",
    );
  const active = () => {
    operation();
    if (originalKey && requireTombKey(tomb) !== originalKey)
      throw new VfsError("locked", "Original tomb key changed.");
  };
  await enqueueTombWrite(tomb, async () => {
    active();
    const key = requireTombKey(tomb);
    const commit = (storageKey: string, value: string) =>
      check && guarded
        ? guarded(storageKey, value, active, key)
        : vfsSeams.writeRaw(storageKey, value, key);
    const envelope: SealedFileEnvelope = { v: 1, dataB64: bytesToB64(bytes) };
    const blob = await vfsSeams.seal(
      key,
      envelope,
      vaultSealBinding(tomb, path),
    );
    active();
    assertSealed(blob);
    await commit(tombFileKey(tomb, path), JSON.stringify(blob));
    active();
    await reviseIndex(tomb, key, path, true, active, commit);
    active();
    await registerTomb(tomb, active, commit);
    active();
  });
}

/**
 * Unseal a file. Throws `VfsError("not-found")` when the path has no file,
 * `VfsError("locked")` before the tomb is unlocked.
 */
export async function readFile(
  tomb: string,
  path: string,
): Promise<Uint8Array> {
  assertSealedPath(path);
  const key = requireTombKey(tomb);
  const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
  if (raw === null) {
    throw new VfsError("not-found", `tomb "${tomb}" has no file at "${path}".`);
  }
  const blob = parseSealedBlob(raw, tomb, path);
  return parseEnvelope(
    await vfsSeams.open(key, blob, vaultSealBinding(tomb, path)),
    tomb,
    path,
  );
}

/**
 * List file paths under `prefix` ("" for everything) from the sealed index.
 * Names never leave the tomb unencrypted — listing needs the key.
 */
export async function listDir(tomb: string, prefix: string): Promise<string[]> {
  assertTombName(tomb);
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (trimmed) assertFilePath(trimmed);
  const key = requireTombKey(tomb);
  const index = await readIndex(tomb, key);
  return Object.keys(index.files)
    .filter(
      (path) =>
        trimmed === "" || path === trimmed || path.startsWith(`${trimmed}/`),
    )
    .sort();
}

/** Remove a sealed file and its index entry. Locked ciphertext stays. */
export async function deleteFile(tomb: string, path: string): Promise<void> {
  assertSealedPath(path);
  await enqueueTombWrite(tomb, async () => {
    const storageKey = tombFileKey(tomb, path);
    const key = tombKeys.get(tomb);
    if (!key && vfsSeams.readRaw(storageKey) !== null) requireTombKey(tomb);
    if (!key) return;
    await vfsSeams.deleteRaw(storageKey);
    await reviseIndex(tomb, key, path, false);
  });
}

/* ------------------------------------------------- verbatim sealed (body) */

/** Read a caller-sealed blob verbatim. The store seals the body; opening it still takes the vault key. */
export function readSealedFile(tomb: string, path: string): SealedBlob | null {
  assertSealedPath(path);
  const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
  if (raw === null) return null;
  return parseSealedBlob(raw, tomb, path);
}

/**
 * Store a caller-sealed blob verbatim and record it in the index. The key is
 * required for the index update, not for the content.
 */
export async function writeSealedFile(
  tomb: string,
  path: string,
  blob: SealedBlob,
  check?: () => void,
  turn?: TombWriteTurn,
): Promise<void> {
  const operation = originalVfsCheck(check);
  assertSealedPath(path);
  const key = requireTombKey(tomb);
  const active = () => {
    operation();
    if (requireTombKey(tomb) !== key)
      throw new VfsError("locked", "Original tomb key changed.");
  };
  await enqueueTombWrite(
    tomb,
    async () => {
      active();
      assertSealed(blob);
      await vfsSeams.writeRaw(
        tombFileKey(tomb, path),
        JSON.stringify(blob),
        key,
      );
      active();
      await reviseIndex(tomb, key, path, true, active);
      active();
      await registerTomb(tomb, active);
      active();
    },
    turn,
  );
}

/**
 * Record an existing sealed file in the index without rewriting its content
 * (a body moved pre-unlock never got an index entry — phase B had no key).
 */
export async function ensureIndexed(tomb: string, path: string): Promise<void> {
  assertSealedPath(path);
  await enqueueTombWrite(tomb, async () => {
    const key = requireTombKey(tomb);
    if (vfsSeams.readRaw(tombFileKey(tomb, path)) === null) return;
    const index = await readIndex(tomb, key);
    if (index.files[path] !== undefined) return;
    await reviseIndex(tomb, key, path, true);
  });
}
