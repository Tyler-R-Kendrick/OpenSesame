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
import {
  BODY_PATH,
  INDEX_PATH,
  SEAL_BOUND_MARKER_PATH,
  readPlaintextFile,
  tombFileKey,
  unlockTomb,
  vfsSeams,
  writePlaintextFile,
} from "../vfs.js";

import {
  type TombWriteTurn,
  assertTombWriteTurn,
  withTombWriteTurn,
} from "../vfs-write-order.js";

export { openJsonForRebind } from "@opensesame/vault-core";

/** Cancellation and original transport identity only; supplies no root or admission verdict. */
function originalSealIO(check?: () => void) {
  const { readRaw, writeRaw, open, seal } = vfsSeams;
  const active = () => {
    check?.();
    if (
      vfsSeams.readRaw !== readRaw ||
      vfsSeams.writeRaw !== writeRaw ||
      vfsSeams.open !== open ||
      vfsSeams.seal !== seal
    )
      throw new Error("Original vault seal transport changed.");
  };
  active();
  return Object.freeze({
    active,
    readRaw: readRaw.bind(vfsSeams),
    writeRaw: writeRaw.bind(vfsSeams),
    open: <T>(key: CryptoKey, blob: SealedBlob, binding?: string): Promise<T> =>
      open<T>(key, blob, binding),
    seal: seal.bind(vfsSeams),
  });
}
type OriginalSealIO = ReturnType<typeof originalSealIO>;

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
  io: OriginalSealIO,
): Promise<BoundaryValue> {
  io.active();
  const binding = vaultSealBinding(tomb, path);
  const opened = await openJsonForRebind<BoundaryValue>(key, blob, binding);
  io.active();
  if (opened.rebound) {
    const next = await sealJson(key, opened.value, binding);
    io.active();
    assertSealed(next);
    await io.writeRaw(tombFileKey(tomb, path), JSON.stringify(next));
    io.active();
  }
  return opened.value;
}

async function rebindIndex(
  tomb: string,
  key: CryptoKey,
  io: OriginalSealIO,
): Promise<TombIndex> {
  io.active();
  const raw = io.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!raw) {
    const empty = emptyIndex();
    const binding = vaultSealBinding(tomb, INDEX_PATH);
    const sealed = await sealJson(key, empty, binding);
    io.active();
    assertSealed(sealed);
    await io.writeRaw(tombFileKey(tomb, INDEX_PATH), JSON.stringify(sealed));
    io.active();
    return empty;
  }
  const blob = parseBlob(raw);
  if (!blob) return emptyIndex();
  return parseIndex(await rewriteIfUnbound(tomb, key, INDEX_PATH, blob, io));
}

/**
 * Rewrite every unbound seal in the tomb, then mark the tomb so later opens
 * require the path binding. Safe to call on every unlock.
 */
export async function rebindTombSeals(
  tomb: string,
  key: CryptoKey,
  check?: () => void,
): Promise<void> {
  const io = originalSealIO(check);
  if (readPlaintextFile(tomb, SEAL_BOUND_MARKER_PATH) === "1") return;
  const index = await rebindIndex(tomb, key, io);
  io.active();
  const paths = new Set<string>(Object.keys(index.files));
  paths.add(BODY_PATH);
  for (const path of paths) {
    if (path === INDEX_PATH) continue;
    const raw = io.readRaw(tombFileKey(tomb, path));
    if (!raw) continue;
    const blob = parseBlob(raw);
    if (!blob) continue;
    await rewriteIfUnbound(tomb, key, path, blob, io);
    io.active();
  }
  io.active();
  await writePlaintextFile(tomb, SEAL_BOUND_MARKER_PATH, "1", io.active);
  io.active();
}

async function publishRekeyedSeals(
  tomb: string,
  sealed: readonly [string, SealedBlob][],
  io: OriginalSealIO,
): Promise<void> {
  const written: [string, string | null, string][] = [];
  try {
    for (const [path, blob] of sealed) {
      io.active();
      assertSealed(blob);
      const key = tombFileKey(tomb, path);
      const previous = io.readRaw(key);
      const emitted = JSON.stringify(blob);
      await io.writeRaw(key, emitted);
      written.push([key, previous, emitted]);
      io.active();
    }
  } catch (error) {
    // Restore only this publication; preserve displaced peer bytes and clean up other owned writes.
    let displaced = false;
    for (const [key, previous, emitted] of written.reverse()) {
      io.active();
      if (io.readRaw(key) !== emitted) {
        displaced = true;
        continue;
      }
      if (previous !== null) {
        await io.writeRaw(key, previous);
        io.active();
      }
    }
    if (displaced)
      throw new Error("A different writer replaced the rotation publication.", {
        cause: error,
      });
    throw error;
  }
}

/**
 * Re-seal every sealed file of a tomb from `from` to `to`, for a vault-key
 * rotation, then point the tomb at `to`. The body is the store's to seal from
 * memory, so it is left alone here. Every file is opened and re-sealed before
 * any is written, so one that cannot be read stops the rotation with the tomb
 * as it was. On publication failure, completed writes still holding our exact
 * emitted bytes are restored; displaced bytes are preserved. Accepted physical
 * writes with failed completion or cancellation can require recovery. This is
 * cooperating-process ordering, not crash atomicity or cross-process CAS.
 * A file left under the old key would be unreadable once that key is gone.
 * Returns the imported new key.
 */
export async function rekeyTomb(
  tomb: string,
  from: CryptoKey,
  nextRaw: Uint8Array,
  check?: () => void,
  turn?: TombWriteTurn,
): Promise<CryptoKey> {
  if (!turn)
    return withTombWriteTurn(tomb, (owned) =>
      rekeyTomb(tomb, from, nextRaw, check, owned),
    );
  assertTombWriteTurn(tomb, turn);
  const io = originalSealIO(check);
  const to = await importVaultKey(nextRaw);
  io.active();
  // Entering the original turn has already drained earlier cooperating writes.
  io.active();
  // Bound first: a seal that predates path binding is rewritten, never carried.
  await rebindTombSeals(tomb, from, io.active);
  io.active();
  const rawIndex = io.readRaw(tombFileKey(tomb, INDEX_PATH));
  const indexBlob = rawIndex ? parseBlob(rawIndex) : null;
  if (!indexBlob) {
    unlockTomb(tomb, to);
    return to;
  }
  const index = parseIndex(
    await io.open(from, indexBlob, vaultSealBinding(tomb, INDEX_PATH)),
  );
  io.active();
  const sealed: [string, SealedBlob][] = [];
  for (const path of Object.keys(index.files)) {
    if (path === BODY_PATH || path === INDEX_PATH) continue;
    const raw = io.readRaw(tombFileKey(tomb, path));
    const blob = raw ? parseBlob(raw) : null;
    if (!blob) continue;
    const binding = vaultSealBinding(tomb, path);
    const value: BoundaryValue = await io.open(from, blob, binding);
    io.active();
    sealed.push([path, await io.seal(to, value, binding)]);
    io.active();
  }
  sealed.push([
    INDEX_PATH,
    await io.seal(to, index, vaultSealBinding(tomb, INDEX_PATH)),
  ]);
  io.active();
  await publishRekeyedSeals(tomb, sealed, io);
  io.active();
  unlockTomb(tomb, to);
  return to;
}
