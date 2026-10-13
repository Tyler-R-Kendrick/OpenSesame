/** Fixed receiver slot DATA only. Private fresh command retains actual Root/factors/CRED→BODY. */
import { type JsonObject, isJsonObject, isNumber } from "@opensesame/os-domain";
import { vaultSealBinding } from "@opensesame/vault-core";
import { z } from "zod";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
import { assertFilePath } from "../vfs-metadata-data.js";
import type { CanaryIndexedSealData } from "./original-indexed-seal-data.js";
export type IndexedCanarySlotData = Readonly<{
  read: () => Promise<string | null>;
  publish: (expected: string | null, next: string) => Promise<void>;
}>;
export const CANARY_RECORD_LIMIT = 128 << 10;
export const CANARY_INDEX_LIMIT = 2 << 20;
const blob = z.strictObject({
  ivB64: z.string().max(32),
  ctB64: z.string().max(8 << 20),
});
function unavailable(): never {
  throw new Error("Original indexed canary record unavailable.");
}
export function canaryLogicalPath(serviceId: string) {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) unavailable();
  return `opensesame-private/agent-canaries/${serviceId}.v1`;
}
export function indexedCanaryBlob(wire: string, bound: number) {
  assertUnambiguousJson(wire, bound);
  return blob.parse(JSON.parse(wire));
}
function validatedCanaryPaths(files: JsonObject) {
  const paths = Object.keys(files).sort();
  if (paths.length > 128) unavailable();
  for (const path of paths) {
    assertFilePath(path);
    if (new TextEncoder().encode(path).length > 511) unavailable();
    const revision = files[path];
    if (
      !isNumber(revision) ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision >= Number.MAX_SAFE_INTEGER
    )
      unavailable();
  }
  return paths;
}
export async function readCanaryIndexData(
  tomb: string,
  wire: string,
  key: CryptoKey,
  seal: CanaryIndexedSealData,
  original: () => void,
) {
  original();
  const index = await seal.open(
    key,
    indexedCanaryBlob(wire, CANARY_INDEX_LIMIT),
    vaultSealBinding(tomb, "index"),
  );
  original();
  if (!isJsonObject(index) || index.v !== 1 || !isJsonObject(index.files))
    unavailable();
  const paths = validatedCanaryPaths(index.files);
  original();
  return { index, paths };
}
export async function nextCanaryIndexData(
  tomb: string,
  before: Awaited<ReturnType<typeof readCanaryIndexData>>,
  path: string,
  key: CryptoKey,
  seal: CanaryIndexedSealData,
  original: () => void,
) {
  original();
  if (before.index.v !== 1 || !isJsonObject(before.index.files)) unavailable();
  const files = { ...before.index.files };
  validatedCanaryPaths(files);
  const previous = files[path] ?? 0;
  if (
    !isNumber(previous) ||
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    previous >= Number.MAX_SAFE_INTEGER - 1
  )
    unavailable();
  Object.defineProperty(files, path, {
    value: previous + 1,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  validatedCanaryPaths(files);
  const next = JSON.stringify(
    await seal.seal(
      key,
      { ...before.index, files },
      vaultSealBinding(tomb, "index"),
    ),
  );
  original();
  if (new TextEncoder().encode(next).length > CANARY_INDEX_LIMIT) unavailable();
  return next;
}
