/**
 * What a departure or return cut short can leave behind (ADR 0143): files in
 * a tomb whose header is gone. The header holds every key wrap, and nothing
 * writes a tomb's files before its header (creation and forking write it
 * first; departure removes it first; return registers the tomb, then writes
 * the header last), so these files can never be opened on this device. The
 * bundle holds all of them: clearing them loses nothing, and a return
 * restores the vault whole either way.
 *
 * Only sealed files inside the tomb count. A vault still kept under the
 * pre-tomb keys has no tomb header yet and is not a remnant; neither is a
 * project registered but never sealed, which holds at most the plaintext
 * markers entering it writes (`migrated.v1`, `seal-bound.v1`).
 */

import { kvFileName } from "../kv.js";
import { LEGACY_VAULT_KEYS } from "../projects-state.js";
import { scopedKey } from "../projects.js";
import { MIGRATION_MARKER_PATH, SEAL_BOUND_MARKER_PATH } from "../vfs.js";
import {
  type TravelDeps,
  type TravelGateRefusal,
  travelGate,
} from "./depart.js";
import { dropAllows } from "./grants.js";
import { SESSION_TOMBS, headerOf, tombOwning, tombStem } from "./storage.js";

const SESSIONS: ReadonlySet<string> = new Set(SESSION_TOMBS);

/** Plaintext markers a tomb can hold before it has a header. */
function isMarker(id: string, file: string): boolean {
  return [MIGRATION_MARKER_PATH, SEAL_BOUND_MARKER_PATH].some(
    (path) => file === `${tombStem(id)}${path}.json`,
  );
}

export type TravelRemnant = Readonly<{ id: string; files: readonly string[] }>;

export type ClearRemnantsOutcome =
  | { ok: true; cleared: readonly string[]; leftovers: readonly string[] }
  | { ok: false; code: TravelGateRefusal };

/** Registered tombs holding tomb files but no header, and no legacy vault. */
export async function findRemnants(deps: TravelDeps): Promise<TravelRemnant[]> {
  const present = await deps.storage.listFiles();
  const have = new Set(present);
  const tombs = deps.storage.tombs();
  const known = [...new Set([...tombs, ...SESSION_TOMBS])];
  return tombs
    .filter(
      (id) =>
        !SESSIONS.has(id) &&
        !have.has(headerOf(id)) &&
        !have.has(kvFileName(scopedKey(LEGACY_VAULT_KEYS[0], id))),
    )
    .map((id) => ({
      id,
      files: present
        .filter(
          (file) =>
            file.startsWith(tombStem(id)) && tombOwning(file, known) === id,
        )
        .sort(),
    }))
    .filter((remnant) =>
      remnant.files.some((file) => !isMarker(remnant.id, file)),
    );
}

async function removeEach(
  deps: TravelDeps,
  files: readonly string[],
): Promise<Set<string>> {
  const removed = new Set<string>();
  for (const file of files) {
    try {
      await deps.storage.remove(file);
      removed.add(file);
    } catch {
      // Reported as a leftover.
    }
  }
  return removed;
}

/**
 * Remove every remnant, read again under the travel lock so a return in
 * another tab is never mistaken for one. A tomb with nothing left leaves the
 * registry, and whatever let a site in for it goes too; its blocks stay.
 */
export function clearRemnants(deps: TravelDeps): Promise<ClearRemnantsOutcome> {
  return deps.exclusive(async () => {
    const refused = await travelGate(deps);
    if (refused) return { ok: false, code: refused };
    const remnants = await findRemnants(deps);
    const removed = await removeEach(
      deps,
      remnants.flatMap((remnant) => remnant.files),
    );
    deps.storage.forget(removed);
    const leftovers = remnants.flatMap((remnant) =>
      remnant.files.filter((file) => !removed.has(file)),
    );
    const cleared = remnants
      .filter((remnant) => remnant.files.every((file) => removed.has(file)))
      .map((remnant) => remnant.id);
    const rewritten = new Set<string>();
    for (const id of cleared) {
      for (const file of await dropAllows(deps.storage, id))
        rewritten.add(file);
      await deps.storage.unregisterTomb(id);
    }
    // The broker reads grants from memory: what was rewritten must be re-read.
    deps.storage.forget(rewritten);
    if (cleared.length > 0) await deps.forgetVaults(cleared);
    return { ok: true, cleared, leftovers };
  });
}
