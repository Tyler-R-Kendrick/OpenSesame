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
  const index = await rebindIndex(tomb, key);
  const paths = new Set<string>(Object.keys(index.files));
  paths.add(BODY_PATH);
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
