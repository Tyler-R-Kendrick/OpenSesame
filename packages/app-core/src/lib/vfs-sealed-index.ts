/** Sealed directory metadata shares the request's original key admission. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { type SealedBlob, vaultSealBinding } from "@opensesame/vault-core";
import { VfsError } from "./vfs-errors.js";
export type SealedIndexHost = {
  read(tomb: string, path: string): string | null;
  write(tomb: string, path: string, text: string): Promise<void>;
  open(
    key: CryptoKey,
    blob: SealedBlob,
    binding: string,
  ): Promise<BoundaryValue>;
  seal(
    key: CryptoKey,
    value: BoundaryValue,
    binding: string,
  ): Promise<SealedBlob>;
};
type TombIndex = { v: 1; files: Record<string, number> };
const INDEX_PATH = "index";
function parseIndex(value: BoundaryValue): TombIndex {
  const files: Record<string, number> = {};
  if (isJsonObject(value) && isJsonObject(value.files))
    for (const [path, rev] of Object.entries(value.files))
      if (isNumber(rev)) files[path] = rev;
  return { v: 1, files };
}
export async function readSealedIndex(
  host: SealedIndexHost,
  tomb: string,
  key: CryptoKey,
  assertCurrent: () => void,
): Promise<TombIndex> {
  assertCurrent();
  const raw = host.read(tomb, INDEX_PATH);
  if (!raw) return { v: 1, files: {} };
  let blob: SealedBlob;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (
      !isJsonObject(parsed) ||
      !isString(parsed.ivB64) ||
      !isString(parsed.ctB64)
    )
      throw new Error("not sealed");
    blob = { ivB64: parsed.ivB64, ctB64: parsed.ctB64 };
  } catch {
    throw new VfsError("corrupt", `Tomb "${tomb}" index is not a sealed blob.`);
  }
  const opened = await host.open(key, blob, vaultSealBinding(tomb, INDEX_PATH));
  assertCurrent();
  return parseIndex(opened);
}
export async function reviseSealedIndex(
  host: SealedIndexHost,
  tomb: string,
  key: CryptoKey,
  path: string,
  written: boolean,
  assertCurrent: () => void,
): Promise<void> {
  const index = await readSealedIndex(host, tomb, key, assertCurrent);
  assertCurrent();
  if (written) index.files[path] = (index.files[path] ?? 0) + 1;
  else delete index.files[path];
  const blob = await host.seal(key, index, vaultSealBinding(tomb, INDEX_PATH));
  assertCurrent();
  await host.write(tomb, INDEX_PATH, JSON.stringify(blob));
  assertCurrent();
}
