/**
 * Where a duress decoy runs when the guest tomb already holds a sealed vault
 * of its own — a guest who enrolled a PIN, a password or a passkey.
 *
 * A decoy is a fresh, guest-looking session. It must never destroy a sealed
 * vault, so beside a sealed guest it runs in a scratch tomb instead of wiping
 * `GUEST_TOMB`. The scratch tomb is never a project, presents as the guest
 * road, and is erased when the session ends.
 */

import { kvSet } from "../../kv.js";
import { headerCarriesGate } from "../../vault/header-gate.js";
import { readTombHeader } from "../../vault/store-header.js";
import { ATTEMPTS_KEY, type VaultScope } from "../../vault/store-scope.js";
import { wipeTombOnDestroy } from "../../vault/tomb-migration.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  TOMBS_REGISTRY_KEY,
  deleteFile,
  listTombs,
} from "../../vfs.js";

/** Plaintext name only; nothing in it says what the session was. */
export const DECOY_SCRATCH_TOMB = "guest-scratch";

/** True when the guest tomb carries its own key (a vault a decoy must not wipe). */
export function guestTombIsSealed(): boolean {
  return headerCarriesGate(readTombHeader(GUEST_TOMB));
}

/**
 * The scratch scope. Its lockout counter is its own: deleting the decoy clears
 * that counter, and must never reset the sealed guest's.
 */
export function decoyScratchScope(): VaultScope {
  return {
    tomb: DECOY_SCRATCH_TOMB,
    attempts: `${ATTEMPTS_KEY}.${DECOY_SCRATCH_TOMB}`,
  };
}

/** The guest isolation tomb or the decoy's stand-in for it. */
export function isGuestSessionTomb(tomb: string | null): boolean {
  return tomb === GUEST_TOMB || tomb === DECOY_SCRATCH_TOMB;
}

/** What the snapshot reports: the scratch tomb presents as the guest road. */
export function presentedTomb(tomb: string): string {
  return tomb === DECOY_SCRATCH_TOMB ? GUEST_TOMB : tomb;
}

/**
 * Drop the scratch tomb from the registry synchronously. The registry is the
 * record `vfs.ts` keeps (`{ v: 1, tombs }`); writing memory now (kvSet) means
 * the project list rebuilt on lock can never show the scratch tomb.
 */
export function forgetDecoyScratch(tomb: string): void {
  if (tomb !== DECOY_SCRATCH_TOMB) return;
  const tombs = listTombs();
  if (!tombs.includes(DECOY_SCRATCH_TOMB)) return;
  const rest = tombs.filter((name) => name !== DECOY_SCRATCH_TOMB).sort();
  kvSet(TOMBS_REGISTRY_KEY, JSON.stringify({ v: 1, tombs: rest }));
}

/** End an ephemeral session's tomb: the scratch tomb goes whole, guest keeps its wipe. */
export async function endEphemeralTomb(tomb: string): Promise<void> {
  if (tomb !== DECOY_SCRATCH_TOMB) {
    await wipeTombOnDestroy(tomb);
    return;
  }
  forgetDecoyScratch(tomb);
  await Promise.all([deleteFile(tomb, BODY_PATH), wipeTombOnDestroy(tomb)]);
}
