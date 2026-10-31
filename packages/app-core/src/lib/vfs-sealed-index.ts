/** Existing sealed index serialization, with an optional original-owner commit sink. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { type SealedBlob, vaultSealBinding } from "@opensesame/vault-core";
import {
  VFS_INDEX_LOCK_PREFIX,
  withVfsCrossTabLock,
} from "./vfs-cross-tab-lock.js";
import { VfsError } from "./vfs-error.js";
import {
  type TombIndex,
  assertTombName,
  isSealedBlob,
  parseIndex,
} from "./vfs-metadata-data.js";
import { vfsSeams } from "./vfs-seams.js";

export const INDEX_PATH = "index";
function indexStorageKey(tomb: string): string {
  assertTombName(tomb);
  return `tomb/${tomb}/${INDEX_PATH}`;
}

export async function readIndex(
  tomb: string,
  key: CryptoKey,
  check: () => void = () => {},
): Promise<TombIndex> {
  check();
  const raw = vfsSeams.readRaw(indexStorageKey(tomb));
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
export async function reviseIndex(
  tomb: string,
  key: CryptoKey,
  path: string,
  written: boolean,
  check: () => void = () => {},
  commit: (storageKey: string, value: string) => Promise<void> = (
    storageKey,
    value,
  ) => vfsSeams.writeRaw(storageKey, value),
): Promise<void> {
  await withVfsCrossTabLock(`${VFS_INDEX_LOCK_PREFIX}${tomb}`, async () => {
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
    await commit(indexStorageKey(tomb), JSON.stringify(blob));
    check();
  });
}
