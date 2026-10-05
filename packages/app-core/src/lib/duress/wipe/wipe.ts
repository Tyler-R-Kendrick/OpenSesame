/**
 * Remove this browser's copy of the vaults, in two phases that survive a page
 * dying between them (ADR 0167).
 *
 * Intent first: the vaults to remove are journaled before a file is touched.
 * Then headers, then the rest. A vault with no header cannot be unlocked even
 * if its body is still there, so an interruption after the first phase has
 * already done the part that matters, and the next boot finishes the other.
 * The intent is cleared only when the device is read back and nothing of those
 * vaults is left.
 *
 * This is application-scoped removal: what the browser's storage deleted, not
 * what the disk may still hold. It reuses travel mode's storage and ownership
 * rules (`travel/storage.ts`) and writes no second removal path.
 */

import type { TravelStorage } from "../../travel/storage.js";
import {
  clearWipeIntent,
  readWipeIntent,
  wipeIntentPending,
  writeWipeIntent,
} from "./intent.js";
import { filesToWipe, headerFilesOf, vaultsToWipe } from "./targets.js";

export type WipeDeps = Readonly<{
  storage: TravelStorage;
  /** Vault ids the device lists beyond its tomb registry (the projects list). */
  knownIds: () => readonly string[];
  /** Wait for writes already in the air, so none recreates a removed file. */
  settle: () => Promise<void>;
  /** Run `work` while no other tab moves vaults. */
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /**
   * Quietly make the app's memory and boot pointer agree with storage: keys
   * forgotten, the active vault no longer one that is gone. Nothing here may
   * redraw a screen; the view is brought up to date by the caller (`real.ts`).
   */
  afterRemoval: (gone: readonly string[]) => Promise<void>;
  now: () => Date;
}>;

export type WipeReceipt = Readonly<{
  vaults: readonly string[];
  removedFiles: number;
  /** Files still present after removal; empty when the removal held. */
  leftovers: readonly string[];
  completion: "applied_local" | "incomplete";
  /** Not a forensic wipe: what the browser deleted is all this claims. */
  assurance: "application_scoped_removal";
  /** Whether the intent could be journaled before removal began. */
  intentRecorded: boolean;
}>;

async function removeEach(
  storage: TravelStorage,
  files: readonly string[],
): Promise<void> {
  for (const file of files) {
    try {
      await storage.remove(file);
    } catch {
      // Counted as a leftover when the device is read back.
    }
  }
}

/** Headers, then everything else, for the vaults in `ids`. */
async function removeVaults(
  deps: WipeDeps,
  ids: readonly string[],
): Promise<Omit<WipeReceipt, "intentRecorded">> {
  await deps.settle();
  const { storage } = deps;
  const tombs = storage.tombs();
  const targets = filesToWipe(ids, await storage.listFiles(), tombs);
  const headers = headerFilesOf(ids);
  await removeEach(
    storage,
    targets.filter((file) => headers.has(file)),
  );
  await removeEach(
    storage,
    targets.filter((file) => !headers.has(file)),
  );
  // Memory forgets every target, removed or not: a file the browser would not
  // delete must not keep a vault openable for the rest of this session.
  storage.forget(new Set(targets));
  const left = filesToWipe(ids, await storage.listFiles(), tombs);
  const gone = ids.filter(
    (id) => filesToWipe([id], left, [...tombs, ...ids]).length === 0,
  );
  for (const id of gone) await storage.unregisterTomb(id);
  await deps.afterRemoval(gone);
  return {
    vaults: ids,
    removedFiles: targets.length - left.length,
    leftovers: left,
    completion: left.length === 0 ? "applied_local" : "incomplete",
    assurance: "application_scoped_removal",
  };
}

/**
 * Remove every vault on this device but the session tombs. The intent is
 * journaled first; storage refusing it does not stop a wipe the owner asked
 * for, it only means a crash would not resume.
 */
export function wipeDevice(deps: WipeDeps): Promise<WipeReceipt> {
  return deps.exclusive(async () => {
    const ids = vaultsToWipe(deps.storage.tombs(), deps.knownIds());
    const intentRecorded = await writeWipeIntent(ids, deps.now());
    const receipt = await removeVaults(deps, ids);
    if (receipt.completion === "applied_local") await clearWipeIntent();
    return { ...receipt, intentRecorded };
  });
}

/**
 * Finish a wipe that was cut short. One attempt: the intent is cleared when it
 * ends, so a file the browser will not remove cannot cost a vault the owner
 * makes later. An intent this build cannot read is left alone and does nothing.
 */
export function resumeWipe(deps: WipeDeps): Promise<WipeReceipt | null> {
  if (!wipeIntentPending()) return Promise.resolve(null);
  return deps.exclusive(async () => {
    const intent = readWipeIntent();
    if (!intent) return null;
    const receipt = await removeVaults(deps, intent.ids);
    await clearWipeIntent();
    return { ...receipt, intentRecorded: true };
  });
}
