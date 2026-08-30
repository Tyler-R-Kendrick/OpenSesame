import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { kvDeleteDurable, kvGet, kvSetDurable } from "./kv.js";
import {
  type SealedBlob,
  assertSealed,
  b64ToBytes,
  bytesToB64,
  openJson,
  sealJson,
} from "./vault/crypto.js";

/**
 * Encrypted VFS — tomb-addressed storage for the Pages vault (ADR 0063).
 *
 * Every vault is a tomb: a named volume with its own vault key, its own
 * sealed body, its own config area. The personal vault is the `personal`
 * tomb (ADR 0038); a project-scoped vault is the tomb named after its
 * project id — the same 1:1 mapping the legacy `scopedKey` scheme used.
 *
 * Layout (logical paths; the kv transport flattens them into OPFS files,
 * with the in-memory fallback preserved):
 *
 *   tombs.v1                    plaintext registry — tomb NAMES only
 *   tomb/<name>/header          plaintext vault header (public KDF params,
 *                               readable pre-unlock by design, ADR 0063)
 *   tomb/<name>/migrated.v1     plaintext legacy-migration marker
 *   tomb/<name>/body            vault body — store-sealed SealedBlob JSON,
 *                               stored verbatim (content unchanged)
 *   tomb/<name>/index           sealed directory index (names + revisions)
 *   tomb/<name>/config/<file>   sealed config (prefs, idp-registry, …)
 *   tomb/<name>/drops/<file>    sealed drop records
 *
 * Every sealed write is AES-GCM under the tomb's vault key (the existing
 * SealedBlob construction). The index is sealed too, so listing requires
 * the key and file names stay private; tomb names are not secrets. No
 * IndexedDB, no localStorage for vault material — OPFS only, via the kv
 * transport's sync read of hydrated memory.
 */

export type VfsErrorCode = "locked" | "not-found" | "invalid-path" | "corrupt";

/** Typed failure for every VFS boundary: locked tomb, bad path, tampered file. */
export class VfsError extends Error {
  readonly code: VfsErrorCode;

  constructor(code: VfsErrorCode, message: string) {
    super(message);
    this.name = "VfsError";
    this.code = code;
  }
}

/** The personal vault's tomb — same name as the personal project (ADR 0038). */
export const PERSONAL_TOMB = "personal";

/** Plaintext top-level registry key — tomb names only, never contents. */
export const TOMBS_REGISTRY_KEY = "tombs.v1";

export const HEADER_PATH = "header";
export const BODY_PATH = "body";
export const INDEX_PATH = "index";
/** Idempotent legacy-migration marker (plaintext; names, not contents). */
export const MIGRATION_MARKER_PATH = "migrated.v1";

const TOMB_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PATH_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/* ------------------------------------------------------------------ seams */

export type VfsSeams = {
  /** Sync read of hydrated kv memory (OPFS is pulled in by `kvHydrate`). */
  readRaw: (key: string) => string | null;
  writeRaw: (key: string, value: string) => Promise<void>;
  deleteRaw: (key: string) => Promise<void>;
  seal: (vaultKey: CryptoKey, value: BoundaryValue) => Promise<SealedBlob>;
  open: <T>(vaultKey: CryptoKey, blob: SealedBlob) => Promise<T>;
};

export const vfsSeams: VfsSeams = {
  readRaw: (key) => kvGet(key),
  writeRaw: (key, value) => kvSetDurable(key, value),
  deleteRaw: (key) => kvDeleteDurable(key),
  seal: (vaultKey, value) => sealJson(vaultKey, value),
  open: (vaultKey, blob) => openJson(vaultKey, blob),
};

/* ------------------------------------------------------------- tomb keys */

/**
 * Unlocked tomb keys, held for the session exactly like the vault store's
 * own key reference. Registered on unlock, dropped on lock — a sealed read
 * or write against a tomb with no key here fails with `VfsError("locked")`.
 */
const tombKeys = new Map<string, CryptoKey>();

/**
 * Sealed writes are read-modify-write against the tomb index, so they run
 * one at a time per tomb — a body persist and a prefs write can never lose
 * each other's index entries.
 */
const tombWriteChains = new Map<string, Promise<unknown>>();

function enqueueTombWrite<T>(tomb: string, op: () => Promise<T>): Promise<T> {
  const run = (tombWriteChains.get(tomb) ?? Promise.resolve()).then(op);
  tombWriteChains.set(
    tomb,
    run.catch(() => undefined),
  );
  return run;
}

/** Settle every queued tomb write — for tests that need a quiet store. */
export async function vfsFlush(): Promise<void> {
  await Promise.all([...tombWriteChains.values()]);
}

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

function assertTombName(tomb: string): void {
  if (!TOMB_NAME_RE.test(tomb)) {
    throw new VfsError(
      "invalid-path",
      `Invalid tomb name: ${JSON.stringify(tomb)}`,
    );
  }
}

function assertFilePath(path: string): void {
  const segments = path.split("/");
  if (segments.some((segment) => !PATH_SEGMENT_RE.test(segment))) {
    throw new VfsError(
      "invalid-path",
      `Invalid VFS path: ${JSON.stringify(path)}`,
    );
  }
}

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
  if (path === HEADER_PATH || path === MIGRATION_MARKER_PATH) {
    throw new VfsError(
      "invalid-path",
      `"${path}" is a plaintext file — use the plaintext helpers.`,
    );
  }
}

/* --------------------------------------------------------------- registry */

type TombsRegistry = { v: 1; tombs: string[] };

function readRegistry(): string[] {
  const raw = vfsSeams.readRaw(TOMBS_REGISTRY_KEY);
  if (!raw) return [];
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed) || !Array.isArray(parsed.tombs)) return [];
    return parsed.tombs.filter(isString);
  } catch {
    return [];
  }
}

async function writeRegistry(names: string[]): Promise<void> {
  const registry: TombsRegistry = { v: 1, tombs: [...new Set(names)].sort() };
  await vfsSeams.writeRaw(TOMBS_REGISTRY_KEY, JSON.stringify(registry));
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
export async function registerTomb(tomb: string): Promise<void> {
  assertTombName(tomb);
  const names = readRegistry();
  if (names.includes(tomb)) return;
  await writeRegistry([...names, tomb]);
}

export async function unregisterTomb(tomb: string): Promise<void> {
  const names = readRegistry();
  if (!names.includes(tomb)) return;
  await writeRegistry(names.filter((name) => name !== tomb));
}

/* ------------------------------------------------------------------ index */

type TombIndex = { v: 1; files: Record<string, number> };

function emptyIndex(): TombIndex {
  return { v: 1, files: {} };
}

function parseIndex(value: BoundaryValue): TombIndex {
  if (!isJsonObject(value) || !isJsonObject(value.files)) return emptyIndex();
  const files: Record<string, number> = {};
  for (const [path, rev] of Object.entries(value.files)) {
    if (isNumber(rev)) files[path] = rev;
  }
  return { v: 1, files };
}

async function readIndex(tomb: string, key: CryptoKey): Promise<TombIndex> {
  const raw = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!raw) return emptyIndex();
  let blob: SealedBlob;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isSealedBlob(parsed)) throw new Error("not sealed");
    blob = parsed;
  } catch {
    throw new VfsError("corrupt", `Tomb "${tomb}" index is not a sealed blob.`);
  }
  return parseIndex(await vfsSeams.open(key, blob));
}

/** Record a write (bump) or a delete (drop) in the sealed directory index. */
async function reviseIndex(
  tomb: string,
  key: CryptoKey,
  path: string,
  written: boolean,
): Promise<void> {
  const index = await readIndex(tomb, key);
  if (written) {
    index.files[path] = (index.files[path] ?? 0) + 1;
  } else {
    delete index.files[path];
  }
  const blob = await vfsSeams.seal(key, index);
  await vfsSeams.writeRaw(tombFileKey(tomb, INDEX_PATH), JSON.stringify(blob));
}

/* ------------------------------------------------------------------ blobs */

function isSealedBlob(value: BoundaryValue): value is SealedBlob {
  return isJsonObject(value) && isString(value.ivB64) && isString(value.ctB64);
}

function parseSealedBlob(raw: string, tomb: string, path: string): SealedBlob {
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (isSealedBlob(parsed)) return parsed;
  } catch {
    /* fall through to the typed error */
  }
  throw new VfsError(
    "corrupt",
    `tomb "${tomb}" file "${path}" is not a sealed blob.`,
  );
}

/** Sealed content envelope: base64 bytes inside the AES-GCM SealedBlob. */
type SealedFileEnvelope = { v: 1; dataB64: string };

function parseEnvelope(
  value: BoundaryValue,
  tomb: string,
  path: string,
): Uint8Array {
  if (isJsonObject(value) && value.v === 1 && isString(value.dataB64)) {
    return b64ToBytes(value.dataB64);
  }
  throw new VfsError(
    "corrupt",
    `tomb "${tomb}" file "${path}" sealed an unexpected payload.`,
  );
}

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
): Promise<void> {
  await vfsSeams.writeRaw(tombFileKey(tomb, path), text);
  await registerTomb(tomb);
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
    const blob = await vfsSeams.seal(key, envelope);
    assertSealed(blob);
    await vfsSeams.writeRaw(tombFileKey(tomb, path), JSON.stringify(blob));
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
  return parseEnvelope(await vfsSeams.open(key, blob), tomb, path);
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

/**
 * Remove a file and its index entry. Deleting the plaintext header needs no
 * key; anything sealed does (the index must be updated).
 */
export async function deleteFile(tomb: string, path: string): Promise<void> {
  assertSealedPath(path);
  await enqueueTombWrite(tomb, async () => {
    await vfsSeams.deleteRaw(tombFileKey(tomb, path));
    const key = tombKeys.get(tomb);
    if (key) await reviseIndex(tomb, key, path, false);
  });
}

/* ------------------------------------------------- verbatim sealed (body) */

/**
 * Read a file that is already a SealedBlob, verbatim. Used for the vault
 * body, which the store seals itself (revision tracking, rollback witness)
 * — its bytes move through the VFS unchanged. No key needed: the caller
 * still cannot open the blob without one. Sync: the transport reads
 * hydrated memory.
 */
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
): Promise<void> {
  assertSealedPath(path);
  await enqueueTombWrite(tomb, async () => {
    const key = requireTombKey(tomb);
    assertSealed(blob);
    await vfsSeams.writeRaw(tombFileKey(tomb, path), JSON.stringify(blob));
    await reviseIndex(tomb, key, path, true);
    await registerTomb(tomb);
  });
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
