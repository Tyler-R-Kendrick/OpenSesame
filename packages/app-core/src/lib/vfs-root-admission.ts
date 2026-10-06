/** An admitted root may not write an older generation over a rotated dataset. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { VfsError } from "./vfs-errors.js";
const roots = new WeakMap<CryptoKey, Map<string, string | null>>();
function identity(raw: string | null): string | null {
  if (!raw) return null;
  const parsed: BoundaryValue = JSON.parse(raw);
  if (!isJsonObject(parsed))
    throw new VfsError("corrupt", "Malformed vault root identity.");
  if (
    isJsonObject(parsed.protection) &&
    isString(parsed.protection.rootKeyId) &&
    isString(parsed.protection.vaultId)
  )
    return `${parsed.protection.vaultId}:${parsed.protection.rootKeyId}`;
  return JSON.stringify({
    createdAt: parsed.createdAt,
    wrap: parsed.wrap,
    unlocks: parsed.unlocks,
  });
}
export function recordRootGeneration(
  tomb: string,
  key: CryptoKey,
  raw: string | null,
): void {
  let own = roots.get(key);
  if (!own) {
    own = new Map();
    roots.set(key, own);
  }
  own.set(tomb, identity(raw));
}
export function assertRootGeneration(
  tomb: string,
  key: CryptoKey,
  raw: string | null,
): void {
  const own = roots.get(key);
  if (!own?.has(tomb) || own.get(tomb) !== identity(raw))
    throw new VfsError("locked", "The vault root changed. Authenticate again.");
}
