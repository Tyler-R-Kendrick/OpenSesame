/**
 * What a departure or return cut short can leave behind (ADR 0143): files of
 * a vault whose header is gone. The header holds every key wrap, and nothing
 * writes a tomb's files before its header (creation and forking write it
 * first; departure removes it first; return writes it last), so these files
 * can never be opened on this device. The bundle holds all of them; clearing
 * them loses nothing, and a return restores the vault whole either way.
 */

import {
  type TravelDeps,
  type TravelGateRefusal,
  travelGate,
} from "./depart.js";
import { SESSION_TOMBS, filesOfVault, headerOf } from "./storage.js";

const SESSIONS: ReadonlySet<string> = new Set(SESSION_TOMBS);

export type TravelRemnant = Readonly<{ id: string; files: readonly string[] }>;

export type ClearRemnantsOutcome =
  | { ok: true; cleared: readonly string[]; leftovers: readonly string[] }
  | { ok: false; code: TravelGateRefusal };

/** Registered tombs holding files but no header. */
export async function findRemnants(deps: TravelDeps): Promise<TravelRemnant[]> {
  const present = await deps.storage.listFiles();
  const tombs = deps.storage.tombs();
  const have = new Set(present);
  return tombs
    .filter((id) => !SESSIONS.has(id) && !have.has(headerOf(id)))
    .map((id) => ({ id, files: filesOfVault(id, present, tombs) }))
    .filter((remnant) => remnant.files.length > 0);
}

/** Remove every remnant; a tomb with nothing left leaves the registry. */
export async function clearRemnants(
  deps: TravelDeps,
): Promise<ClearRemnantsOutcome> {
  const refused = await travelGate(deps);
  if (refused) return { ok: false, code: refused };
  const remnants = await findRemnants(deps);
  const removed = new Set<string>();
  for (const file of remnants.flatMap((remnant) => remnant.files)) {
    try {
      await deps.storage.remove(file);
      removed.add(file);
    } catch {
      // Reported as a leftover below.
    }
  }
  deps.storage.forget(removed);
  const leftovers = remnants.flatMap((remnant) =>
    remnant.files.filter((file) => !removed.has(file)),
  );
  const cleared = remnants
    .filter((remnant) => remnant.files.every((file) => removed.has(file)))
    .map((remnant) => remnant.id);
  for (const id of cleared) await deps.storage.unregisterTomb(id);
  if (cleared.length > 0) await deps.forgetVaults(cleared);
  return { ok: true, cleared, leftovers };
}
