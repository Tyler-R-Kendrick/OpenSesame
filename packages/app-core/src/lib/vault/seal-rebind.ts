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
import { kvHydrate } from "../kv.js";
import {
  BODY_PATH,
  INDEX_PATH,
  SEAL_BOUND_MARKER_PATH,
  readPlaintextFile,
  tombFileKey,
  unlockTomb,
  vfsFlush,
  vfsSeams,
  writePlaintextFile,
} from "../vfs.js";

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
): Promise<BoundaryValue> {
  const binding = vaultSealBinding(tomb, path);
  const opened = await openJsonForRebind<BoundaryValue>(key, blob, binding);
  if (opened.rebound) {
    const next = await sealJson(key, opened.value, binding);
    assertSealed(next);
    await vfsSeams.writeRaw(tombFileKey(tomb, path), JSON.stringify(next));
  }
  return opened.value;
}

async function rebindIndex(tomb: string, key: CryptoKey): Promise<TombIndex> {
  const raw = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  if (!raw) {
    const empty = emptyIndex();
    const binding = vaultSealBinding(tomb, INDEX_PATH);
    const sealed = await sealJson(key, empty, binding);
    assertSealed(sealed);
    await vfsSeams.writeRaw(
      tombFileKey(tomb, INDEX_PATH),
      JSON.stringify(sealed),
    );
    return empty;
  }
  const blob = parseBlob(raw);
  if (!blob) return emptyIndex();
  return parseIndex(await rewriteIfUnbound(tomb, key, INDEX_PATH, blob));
}

/**
 * Rewrite every unbound seal in the tomb, then mark the tomb so later opens
 * require the path binding. Safe to call on every unlock.
 */
export async function rebindTombSeals(
  tomb: string,
  key: CryptoKey,
): Promise<void> {
  if (readPlaintextFile(tomb, SEAL_BOUND_MARKER_PATH) === "1") return;
  // This runs first on a vault's first unlock, ahead of the unlock's own
  // hydrate: on a fresh page the index and the files it names are on disk but
  // not yet in memory. Reading them as absent would seal an empty index over
  // the real one and drop every file written before the reload from the listing.
  await kvHydrate([
    tombFileKey(tomb, INDEX_PATH),
    tombFileKey(tomb, BODY_PATH),
  ]);
  const index = await rebindIndex(tomb, key);
  const paths = new Set<string>(Object.keys(index.files));
  paths.add(BODY_PATH);
  await kvHydrate([...paths].map((path) => tombFileKey(tomb, path)));
  for (const path of paths) {
    if (path === INDEX_PATH) continue;
    const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
    if (!raw) continue;
    const blob = parseBlob(raw);
    if (!blob) continue;
    await rewriteIfUnbound(tomb, key, path, blob);
  }
  await writePlaintextFile(tomb, SEAL_BOUND_MARKER_PATH, "1");
}

/**
 * Re-seal every sealed file of a tomb from `from` to `to`, for a vault-key
 * rotation, then point the tomb at `to`. The body is the store's to seal from
 * memory, so it is left alone here. Every file is opened and re-sealed before
 * any is written, so one that cannot be read stops the rotation with the tomb
 * as it was, and a write that fails part-way is put back. A file left under
 * the old key would be unreadable the moment the old key is gone. Returns the
 * imported new key.
 */
export async function rekeyTomb(
  tomb: string,
  from: CryptoKey,
  nextRaw: Uint8Array,
): Promise<CryptoKey> {
  const to = await importVaultKey(nextRaw);
  await vfsFlush();
  // Bound first: a seal that predates path binding is rewritten, never carried.
  await rebindTombSeals(tomb, from);
  const rawIndex = vfsSeams.readRaw(tombFileKey(tomb, INDEX_PATH));
  const indexBlob = rawIndex ? parseBlob(rawIndex) : null;
  if (!indexBlob) {
    unlockTomb(tomb, to);
    return to;
  }
  const index = parseIndex(
    await vfsSeams.open(from, indexBlob, vaultSealBinding(tomb, INDEX_PATH)),
  );
  const sealed: [string, SealedBlob][] = [];
  for (const path of Object.keys(index.files)) {
    if (path === BODY_PATH || path === INDEX_PATH) continue;
    const raw = vfsSeams.readRaw(tombFileKey(tomb, path));
    const blob = raw ? parseBlob(raw) : null;
    if (!blob) continue;
    const binding = vaultSealBinding(tomb, path);
    const value = await vfsSeams.open<BoundaryValue>(from, blob, binding);
    sealed.push([path, await vfsSeams.seal(to, value, binding)]);
  }
  sealed.push([
    INDEX_PATH,
    await vfsSeams.seal(to, index, vaultSealBinding(tomb, INDEX_PATH)),
  ]);
  const written: [string, string | null][] = [];
  try {
    for (const [path, blob] of sealed) {
      assertSealed(blob);
      const key = tombFileKey(tomb, path);
      const previous = vfsSeams.readRaw(key);
      await vfsSeams.writeRaw(key, JSON.stringify(blob));
      written.push([key, previous]);
    }
  } catch (error) {
    // A write that fails part-way must not leave some files under each key.
    for (const [key, previous] of written.reverse()) {
      if (previous !== null) await vfsSeams.writeRaw(key, previous);
    }
    throw error;
  }
  unlockTomb(tomb, to);
  return to;
}
