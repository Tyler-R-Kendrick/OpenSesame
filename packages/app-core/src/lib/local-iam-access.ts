/** Private pre-unlock IAM access; never installs a general VFS key. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
} from "@opensesame/os-domain";
import {
  assertSealed,
  bytesToB64,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { kvRefresh } from "./kv.js";
import {
  VFS_INDEX_LOCK_PREFIX,
  withVfsCrossTabLock,
} from "./vfs-cross-tab-lock.js";
import {
  parseEnvelope,
  parseIndex,
  parseSealedBlob,
} from "./vfs-metadata-data.js";
import { originalVfsCheck } from "./vfs-operation-check.js";
import type { VfsSeams } from "./vfs-seams-state.js";
import { enqueueTombWrite } from "./vfs-write-order.js";
import { INDEX_PATH, VfsError, tombFileKey, vfsSeams } from "./vfs.js";

const brand: unique symbol = Symbol("private-local-iam");
export type LocalIamAccess = Readonly<{ [brand]: true }>;
type AccessState = { tomb: string; key: CryptoKey | null; check: () => void };
const issued = new WeakMap<LocalIamAccess, AccessState>();
const CREDENTIALS = "config/identity-credentials";
const limits = new Map([
  ["config/trusted-unlock", 64_000],
  ["config/identity-directory", 512_000],
  [CREDENTIALS, 4_000_000],
]);
type GuardedWrite = NonNullable<VfsSeams["writeRawGuarded"]>;

function guardedWriter(): GuardedWrite {
  const write = vfsSeams.writeRawGuarded;
  if (write === undefined)
    throw new Error("This storage cannot safely guard private IAM writes.");
  return write;
}

/** Refuse enrollment before an unsupported store could acquire an unfulfillable policy. */
export function assertPrivateIamWriteSupport(): void {
  guardedWriter();
}

function original(access: LocalIamAccess, tomb: string) {
  const state = issued.get(access);
  if (!state || state.tomb !== tomb || !state.key)
    throw new VfsError("locked", "The private IAM operation ended.");
  try {
    state.check();
  } catch (error) {
    state.key = null;
    issued.delete(access);
    throw error;
  }
  return { key: state.key, check: () => checkLocalIamAccess(access, tomb) };
}

export function checkLocalIamAccess(
  access: LocalIamAccess,
  tomb: string,
): void {
  original(access, tomb);
}

/** The original unlock owns this handle and must revoke it on every exit. */
export function createTrustedUnlockAccess(
  tomb: string,
  key: CryptoKey,
  check: () => void,
): Readonly<{ access: LocalIamAccess; revoke: () => void }> {
  tombFileKey(tomb, CREDENTIALS);
  const state: AccessState = { tomb, key, check: originalVfsCheck(check) };
  state.check();
  const access: LocalIamAccess = Object.freeze({ [brand]: true });
  issued.set(access, state);
  return Object.freeze({
    access,
    revoke: () => {
      state.key = null;
      issued.delete(access);
    },
  });
}

/** Exact IAM files only; a forged, revoked, or differently scoped handle fails. */
export async function readLocalIamFile(
  access: LocalIamAccess,
  tomb: string,
  path: string,
): Promise<Uint8Array> {
  const limit = limits.get(path);
  if (limit === undefined)
    throw new VfsError("invalid-path", "Private IAM cannot read this file.");
  const { key, check } = original(access, tomb);
  const storageKey = tombFileKey(tomb, path);
  await kvRefresh(storageKey, limit * 2 + 4096);
  check();
  const raw = vfsSeams.readRaw(storageKey);
  if (raw === null) throw new VfsError("not-found", "The IAM file is absent.");
  if (raw.length > limit * 2 + 4096)
    throw new VfsError("corrupt", "The IAM ciphertext exceeds its limit.");
  const blob = parseSealedBlob(raw, tomb, path);
  const opened = await vfsSeams.open<BoundaryValue>(
    key,
    blob,
    vaultSealBinding(tomb, path),
  );
  check();
  const bytes = parseEnvelope(opened, tomb, path);
  if (bytes.length > limit)
    throw new VfsError("corrupt", "The IAM file exceeds its limit.");
  return bytes;
}

function advanceCounter(
  value: BoundaryValue,
  credentialId: string,
  previous: number,
  next: number,
) {
  if (
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous > 0xffffffff ||
    !Number.isSafeInteger(next) ||
    next < previous ||
    next > 0xffffffff ||
    (previous > 0 && next === previous) ||
    !isJsonObject(value) ||
    value.version !== 1 ||
    !Array.isArray(value.passkeys)
  )
    throw new VfsError("corrupt", "The credential counter is invalid.");
  const matches = value.passkeys.filter(
    (row) => isJsonObject(row) && row.credentialId === credentialId,
  );
  const held = matches[0];
  if (matches.length !== 1 || !isJsonObject(held) || held.counter !== previous)
    throw new VfsError("corrupt", "The original credential changed.");
  return {
    ...value,
    passkeys: value.passkeys.map((row) =>
      row === held ? { ...held, counter: next } : row,
    ),
  };
}

async function advanceIndex(
  tomb: string,
  key: CryptoKey,
  check: () => void,
  write: GuardedWrite,
) {
  const storageKey = tombFileKey(tomb, INDEX_PATH);
  await kvRefresh(storageKey, 8 * 1024 * 1024);
  check();
  const raw = vfsSeams.readRaw(storageKey);
  if (raw === null) throw new VfsError("corrupt", "The IAM index is absent.");
  const opened = await vfsSeams.open<BoundaryValue>(
    key,
    parseSealedBlob(raw, tomb, INDEX_PATH),
    vaultSealBinding(tomb, INDEX_PATH),
  );
  check();
  const index = parseIndex(opened);
  const revision = index.files[CREDENTIALS];
  if (
    !isNumber(revision) ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision >= Number.MAX_SAFE_INTEGER
  )
    throw new VfsError("corrupt", "The credential index revision is invalid.");
  index.files[CREDENTIALS] = revision + 1;
  const blob = await vfsSeams.seal(
    key,
    index,
    vaultSealBinding(tomb, INDEX_PATH),
  );
  check();
  assertSealed(blob);
  await write(storageKey, JSON.stringify(blob), check, key);
  check();
}

/** Caller holds the genuine directory lock; only an existing counter can change. */
export async function advanceLocalPasskeyCounter(
  access: LocalIamAccess,
  tomb: string,
  credentialId: string,
  previous: number,
  next: number,
): Promise<void> {
  const { key, check } = original(access, tomb);
  const write = guardedWriter();
  await enqueueTombWrite(tomb, () =>
    withVfsCrossTabLock(`${VFS_INDEX_LOCK_PREFIX}${tomb}`, async () => {
      check();
      const bytes = await readLocalIamFile(access, tomb, CREDENTIALS);
      check();
      const value: BoundaryValue = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      const updated = advanceCounter(value, credentialId, previous, next);
      const data = new TextEncoder().encode(JSON.stringify(updated));
      const blob = await vfsSeams.seal(
        key,
        { v: 1, dataB64: bytesToB64(data) },
        vaultSealBinding(tomb, CREDENTIALS),
      );
      check();
      assertSealed(blob);
      await write(
        tombFileKey(tomb, CREDENTIALS),
        JSON.stringify(blob),
        check,
        key,
      );
      check();
      await advanceIndex(tomb, key, check, write);
      check();
    }),
  );
  check();
}
