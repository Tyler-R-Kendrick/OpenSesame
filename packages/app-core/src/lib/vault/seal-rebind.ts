/**
 * One-shot unlock migration: rewrite every unbound AES-GCM seal under the
 * tomb so later reads accept only path-bound seals.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type SealedBlob,
  assertSealed,
  importVaultKey,
  openJsonForRebind,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { enqueueVfsWrite } from "../vfs-write-queue.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  SEAL_BOUND_MARKER_PATH,
  pinTombAuthority,
  readPlaintextFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
  writePlaintextFile,
} from "../vfs.js";
import { withBodyWriteLock } from "./vault-shared-locks.js";

export { openJsonForRebind } from "@opensesame/vault-core";

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

function parseBlob(raw: string): SealedBlob | null {
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (
      isJsonObject(parsed) &&
      isString(parsed.ivB64) &&
      isString(parsed.ctB64)
    ) {
      return { ivB64: parsed.ivB64, ctB64: parsed.ctB64 };
    }
  } catch {
    return null;
  }
  return null;
}

async function rewriteIfUnbound(
  tomb: string,
  key: CryptoKey,
  path: string,
  blob: SealedBlob,
  check: () => void,
): Promise<BoundaryValue> {
  check();
  const binding = vaultSealBinding(tomb, path);
  const opened = await openJsonForRebind<BoundaryValue>(key, blob, binding);
  check();
  if (opened.rebound) {
    const next = await sealJson(key, opened.value, binding);
    check();
    assertSealed(next);
    await vfsSeams.writeRaw(tombFileKey(tomb, path), JSON.stringify(next));
    check();
  }
  return opened.value;
}

async function rebindIndex(
  tomb: string,
  key: CryptoKey,
  check: () => void,
): Promise<TombIndex> {
  check();
  const raw = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!raw) {
    const empty = emptyIndex();
    const binding = vaultSealBinding(tomb, INDEX_PATH);
    const sealed = await sealJson(key, empty, binding);
    check();
    assertSealed(sealed);
    await vfsSeams.writeRaw(
      tombFileKey(tomb, INDEX_PATH),
      JSON.stringify(sealed),
    );
    check();
    return empty;
  }
  const blob = parseBlob(raw);
  if (!blob) return emptyIndex();
  return parseIndex(await rewriteIfUnbound(tomb, key, INDEX_PATH, blob, check));
}

/**
 * Rewrite every unbound seal in the tomb, then mark the tomb so later opens
 * require the path binding. Safe to call on every unlock.
 */
export async function rebindTombSeals(
  tomb: string,
  key: CryptoKey,
  originatingAuthority: () => void = () => {},
): Promise<void> {
  const pin = pinTombAuthority(tomb, key);
  const check = () => {
    originatingAuthority();
    pin();
  };
  check();
  if (readPlaintextFile(tomb, SEAL_BOUND_MARKER_PATH) === "1") return;
  const index = await rebindIndex(tomb, key, check);
  const paths = new Set<string>(Object.keys(index.files));
  paths.add(BODY_PATH);
  for (const path of paths) {
    check();
    if (path === INDEX_PATH) continue;
    const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
    if (!raw) continue;
    const blob = parseBlob(raw);
    if (!blob) continue;
    await rewriteIfUnbound(tomb, key, path, blob, check);
  }
  check();
  await writePlaintextFile(tomb, SEAL_BOUND_MARKER_PATH, "1");
  check();
}

/**
 * Re-seal every sealed file of a tomb from `from` to `to`, for a vault-key
 * rotation, then point the tomb at `to`. The body is the store's to seal from
 * memory, so it is left alone here. Every file is opened and re-sealed before
 * any is written, so one that cannot be read stops the rotation with the tomb
 * as it was, and a write that fails part-way is put back only while its
 * ciphertext and header still belong to this commit. A file left under
 * the old key would be unreadable the moment the old key is gone. Returns the
 * imported new key. Protected Store roots use rotateRootDataset instead,
 * which journals their body and authentication header in the same commit.
 */
export async function rekeyTomb(
  tomb: string,
  from: CryptoKey,
  nextRaw: Uint8Array,
): Promise<CryptoKey> {
  const check = pinTombAuthority(tomb, from);
  check();
  const to = await importVaultKey(nextRaw);
  check();
  await vfsFlush();
  check();
  // Bound first: a seal that predates path binding is rewritten, never carried.
  await rebindTombSeals(tomb, from, check);
  check();
  const snapshot = await prepareRekey(tomb, from, to, check);
  check();
  // Keep the root writer's BODY -> VFS order. Preparation holds neither lock,
  // so revocation or a peer write can cancel it before any rekey dispatch.
  const result = await withBodyWriteLock(tomb, () =>
    enqueueVfsWrite(
      tomb,
      async () => {
        const published = await commitRekey(tomb, snapshot, check, () => {
          check();
          unlockTomb(tomb, to);
          return pinTombAuthority(tomb, to);
        });
        published();
        return { key: to, check: published };
      },
      true,
    ),
  );
  result.check();
  return result.key;
}

type RekeyFile = { path: string; previous: string; next: string };
type RekeySnapshot = {
  header: string | null;
  index: string | null;
  files: RekeyFile[];
};

async function prepareRekey(
  tomb: string,
  from: CryptoKey,
  to: CryptoKey,
  check: () => void,
): Promise<RekeySnapshot> {
  check();
  const header = vfsSeams.readRaw(tombFileKey(tomb, HEADER_PATH));
  const rawIndex = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  const indexBlob = rawIndex ? parseBlob(rawIndex) : null;
  if (!indexBlob || !rawIndex) return { header, index: rawIndex, files: [] };
  const index = parseIndex(
    await vfsSeams.open(from, indexBlob, vaultSealBinding(tomb, INDEX_PATH)),
  );
  check();
  const files: RekeyFile[] = [];
  for (const path of Object.keys(index.files)) {
    check();
    if (path === BODY_PATH || path === INDEX_PATH) continue;
    const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
    const blob = raw ? parseBlob(raw) : null;
    if (!blob || !raw) continue;
    const binding = vaultSealBinding(tomb, path);
    const value = await vfsSeams.open<BoundaryValue>(from, blob, binding);
    check();
    const sealed = await vfsSeams.seal(to, value, binding);
    check();
    assertSealed(sealed);
    files.push({ path, previous: raw, next: JSON.stringify(sealed) });
  }
  const sealedIndex = await vfsSeams.seal(
    to,
    index,
    vaultSealBinding(tomb, INDEX_PATH),
  );
  check();
  assertSealed(sealedIndex);
  files.push({
    path: INDEX_PATH,
    previous: rawIndex,
    next: JSON.stringify(sealedIndex),
  });
  return { header, index: rawIndex, files };
}

function assertRekeyHeader(tomb: string, snapshot: RekeySnapshot): void {
  if (vfsSeams.readRaw(tombFileKey(tomb, HEADER_PATH)) !== snapshot.header)
    throw new Error("The original rekey header is no longer current.");
}

/** Ciphertext-only cleanup owns exact attempted bytes, never successor data. */
async function restoreRekey(
  tomb: string,
  snapshot: RekeySnapshot,
  attempted: RekeyFile[],
): Promise<void> {
  for (const file of attempted.reverse()) {
    assertRekeyHeader(tomb, snapshot);
    const key = tombFileKey(tomb, file.path);
    const current = vfsSeams.readRaw(key);
    if (current === file.previous) continue;
    if (current !== file.next)
      throw new Error("The rekey ciphertext changed before cleanup.");
    await vfsSeams.writeRaw(key, file.previous);
    assertRekeyHeader(tomb, snapshot);
    if (vfsSeams.readRaw(key) !== file.previous)
      throw new Error("The original rekey ciphertext was not restored.");
  }
}

async function commitRekey(
  tomb: string,
  snapshot: RekeySnapshot,
  check: () => void,
  publish: () => () => void,
): Promise<() => void> {
  const current = () => {
    check();
    assertRekeyHeader(tomb, snapshot);
  };
  current();
  if (vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH)) !== snapshot.index)
    throw new Error("The vault index changed during rekey preparation.");
  for (const file of snapshot.files)
    if (vfsSeams.readRaw(tombFileKey(tomb, file.path)) !== file.previous)
      throw new Error("A vault file changed during rekey preparation.");
  const attempted: RekeyFile[] = [];
  try {
    for (const file of snapshot.files) {
      current();
      attempted.push(file);
      await vfsSeams.writeRaw(tombFileKey(tomb, file.path), file.next);
      current();
    }
    // No await may split the final original check from key installation.
    current();
    return publish();
  } catch (error) {
    // The locks remain held across bounded cleanup even if the realm revoked.
    // Unlike a fresh key admission, restoring only our exact ciphertext needs
    // no retained plaintext authority. A changed successor is never replaced.
    await restoreRekey(tomb, snapshot, attempted).catch(() => undefined);
    throw error;
  }
}
