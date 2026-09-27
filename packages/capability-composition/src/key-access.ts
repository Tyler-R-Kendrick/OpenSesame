/**
 * Key access as a set (carried from #470's per-flag declaration). A
 * descriptor names one class or several; `"none"` is the empty set. The
 * digest body keeps a single class a bare string, exactly as before the set
 * existed, so every consent receipt signed over a one-class descriptor still
 * matches — only a descriptor that really holds more than one changes.
 */
import { sortIds } from "./ids.js";
import type { KeyAccess, KeyAccessClass } from "./types.js";

export const KEY_ACCESS_CLASSES: readonly KeyAccessClass[] = [
  "none",
  "item-plaintext",
  "protector-wrap",
  "provider-bearer",
];

function isKeyAccessClass(value: string): value is KeyAccessClass {
  return KEY_ACCESS_CLASSES.some((c) => c === value);
}

/** A declaration as written: validation takes it before it is known good. */
type Declared = string | readonly string[];

/** The classes as declared, a bare class read as a list of one. */
export function listed(k: Declared): readonly string[] {
  return isSingle(k) ? [k] : k;
}

function isSingle(k: Declared): k is string {
  return !Array.isArray(k);
}

/** The classes held, sorted, without `"none"`: the empty list holds nothing. */
export function keyAccessClasses(k: KeyAccess): KeyAccessClass[] {
  return sortIds(listed(k))
    .filter(isKeyAccessClass)
    .filter((c) => c !== "none");
}

/** One class digests as the bare string it always was; several as a sorted list. */
export function keyAccessDigestBody(k: KeyAccess): string | string[] {
  const classes = keyAccessClasses(k);
  const [only, ...more] = classes;
  if (only === undefined) return "none";
  return more.length === 0 ? only : classes;
}

/** Why a declaration is not a key-access set, or `null` when it is one. */
export function keyAccessProblem(k: Declared): string | null {
  const list = listed(k);
  if (list.length === 0) return "key access lists at least one class";
  if (!list.every(isKeyAccessClass)) return "unknown key access class";
  if (new Set(list).size !== list.length) return "key access repeats a class";
  if (list.length > 1 && list.includes("none")) {
    return "none cannot be combined with another class";
  }
  return null;
}
