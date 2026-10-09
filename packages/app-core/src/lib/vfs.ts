import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type SealedBlob,
  assertSealed,
  bytesToB64,
  vaultSealBinding,
} from "@opensesame/vault-core";
import {
  type SealedFileEnvelope,
  type TombIndex,
  type TombsRegistry,
  assertFilePath,
  assertTombName,
  isSealedBlob,
  parseEnvelope,
  parseIndex,
  parseRegistry,
  parseSealedBlob,
} from "./vfs-metadata-data.js";
import { originalVfsCheck } from "./vfs-operation-check.js";
import { vfsSeams } from "./vfs-seams.js";
import { type TombWriteTurn, enqueueTombWrite } from "./vfs-write-order.js";
export { vfsFlush } from "./vfs-write-order.js";

/**
 * Encrypted VFS (ADR 0063). AES-GCM seals bind tomb and path as additional
 * data. Unlock rewrites any unbound seal once, then only bound seals open.
 * Plaintext is tomb names, the header, and migration markers. Storage is OPFS.
 */

import { VfsError } from "./vfs-error.js";
export { VfsError, type VfsErrorCode } from "./vfs-error.js";

/** The personal vault's tomb — same name as the personal project (ADR 0038). */
export const PERSONAL_TOMB = "personal";
/** Isolated guest session tomb — never a project in the vault list. */
export const GUEST_TOMB = "guest";

/** Plaintext top-level registry key — tomb names only, never contents. */
export const TOMBS_REGISTRY_KEY = "tombs.v1";

export const HEADER_PATH = "header";
export const BODY_PATH = "body";
export const INDEX_PATH = "index";
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
): Promise<void> {
  check();
  const registry: TombsRegistry = {
    v: 1,
    tombs: [...new Set(names)].sort(),
  };
  await vfsSeams.writeRaw(TOMBS_REGISTRY_KEY, JSON.stringify(registry));
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
): Promise<void> {
  check();
  assertTombName(tomb);
  const names = readRegistry();
  if (names.includes(tomb)) return;
  await writeRegistry([...names, tomb], check);
}

export async function unregisterTomb(tomb: string): Promise<void> {
  const names = readRegistry();
  if (!names.includes(tomb)) return;
  await writeRegistry(names.filter((name) => name !== tomb));
}

/* ------------------------------------------------------------------ index */

async function readIndex(
  tomb: string,
  key: CryptoKey,
  check: () => void = () => {},
): Promise<TombIndex> {
  check();
  const raw = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!raw) return { v: 1, files: {} };
  let blob: SealedBlob;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isSealedBlob(parsed)) throw new Error("not sealed");
    blob = parsed;
  } catch {
    throw new VfsError("corrupt", `Tomb "${tomb}" index is not a sealed blob.`);
  }
  const opened = await vfsSeams.open<BoundaryValue>(
    key,
    blob,
    vaultSealBinding(tomb, INDEX_PATH),
  );
  check();
  return parseIndex(opened);
}

/** Record a write (bump) or a delete (drop) in the sealed directory index. */
async function reviseIndex(
  tomb: string,
  key: CryptoKey,
  path: string,
  written: boolean,
  check: () => void = () => {},
): Promise<void> {
  check();
  const index = await readIndex(tomb, key, check);
  check();
  if (written) {
    index.files[path] = (index.files[path] ?? 0) + 1;
  } else {
    delete index.files[path];
  }
  const blob = await vfsSeams.seal(
    key,
    index,
    vaultSealBinding(tomb, INDEX_PATH),
  );
  check();
  await vfsSeams.writeRaw(tombFileKey(tomb, INDEX_PATH), JSON.stringify(blob));
  check();
}

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
): Promise<void> {
  assertSealedPath(path);
  await enqueueTombWrite(tomb, async () => {
    const key = requireTombKey(tomb);
    const envelope: SealedFileEnvelope = { v: 1, dataB64: bytesToB64(bytes) };
    const blob = await vfsSeams.seal(
      key,
      envelope,
      vaultSealBinding(tomb, path),
    );
    assertSealed(blob);
    await vfsSeams.writeRaw(tombFileKey(tomb, path), JSON.stringify(blob), key);
    await reviseIndex(tomb, key, path, true);
    await registerTomb(tomb);
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
