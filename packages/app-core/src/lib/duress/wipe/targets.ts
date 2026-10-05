/**
 * What a wipe may touch, decided by what a vault owns and nothing else.
 *
 * A file is removed only if it belongs to a vault being removed: it sits in
 * that vault's tomb, or is one of the plaintext records named for it
 * (`travel/storage.ts`, the same reading travel mode uses). Everything else
 * stays because it is never named, not because a list excludes it: the guest
 * tombs, the duress journals (the armed code and the incident record, so the
 * code still works afterwards), the device's settings, and the at-rest key,
 * which lives in IndexedDB and is not an origin file at all. A protected-name
 * check stands behind that as a second wall, so a future change to ownership
 * cannot reach a duress record without failing a test.
 */

import { kvFileName } from "../../kv.js";
import { LEGACY_VAULT_KEYS } from "../../projects-state.js";
import { scopedKey } from "../../projects.js";
import { SESSION_TOMBS, filesOfVault, headerOf } from "../../travel/storage.js";
import { PERSONAL_TOMB } from "../../vfs.js";
import { DURESS_BOOT_KEYS } from "../store/boot-keys.js";

/** Tombs that exist on a device but are never a vault this removes. */
export const SESSION_VAULTS: ReadonlySet<string> = new Set(SESSION_TOMBS);

const VAULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Whether `id` can be a tomb name at all; a hostile one is never followed. */
export function isVaultName(id: string): boolean {
  return VAULT_NAME.test(id);
}

/** Origin files that are the duress records, whole: the code and its journals. */
const PROTECTED_FILES: ReadonlySet<string> = new Set(
  DURESS_BOOT_KEYS.map(kvFileName),
);

export function isProtectedFile(file: string): boolean {
  return PROTECTED_FILES.has(file);
}

/**
 * The vaults a wipe removes: every tomb on the device and every project the
 * list names, and the personal vault whether or not its tomb is registered,
 * less the session tombs.
 */
export function vaultsToWipe(
  tombs: readonly string[],
  known: readonly string[],
): string[] {
  const ids = new Set([PERSONAL_TOMB, ...tombs, ...known]);
  return [...ids]
    .filter((id) => isVaultName(id) && !SESSION_VAULTS.has(id))
    .sort();
}

/** Every file of `ids` present in `listing`, never a protected one. */
export function filesToWipe(
  ids: readonly string[],
  listing: readonly string[],
  tombs: readonly string[],
): string[] {
  const known = [...new Set([...tombs, ...ids])];
  const files = new Set<string>();
  for (const id of ids) {
    for (const file of filesOfVault(id, listing, known)) {
      if (!isProtectedFile(file)) files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * The files that make a vault openable: its tomb header and, for one not yet
 * moved into a tomb, the legacy flat header. Gone, nothing opens even if the
 * rest is cut short.
 */
export function headerFilesOf(ids: readonly string[]): ReadonlySet<string> {
  return new Set(
    ids.flatMap((id) => [
      headerOf(id),
      kvFileName(scopedKey(LEGACY_VAULT_KEYS[0], id)),
    ]),
  );
}
