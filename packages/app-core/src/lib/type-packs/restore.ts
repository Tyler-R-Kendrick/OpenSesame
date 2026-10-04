/**
 * Bring back the packs this device switched on (ADR 0165).
 *
 * Runs at boot, after the sealed store is hydrated and before the first
 * paint, so the rail and the new-item picker open already knowing their
 * types. No request is made for a pack whose stored copy still matches the
 * build's digest: it is verified and registered from what is on the device,
 * which is also what makes it work offline. A copy that no longer matches
 * (the build carries a newer definition) is queued to be fetched again.
 */

import {
  packEntry,
  registerPack,
  verifyPackText,
} from "@opensesame/vault-item-types";
import { enablePack, packSeams } from "./installer.js";
import { readStoredPacks, updateStoredPacks } from "./persist.js";
import { resetSettled, setStatus } from "./state.js";

export async function restorePacks(): Promise<void> {
  const stored = readStoredPacks();
  const stale: string[] = [];
  const gone: string[] = [];
  for (const id of [...stored.keys()].sort()) {
    const entry = packEntry(id);
    const copy = stored.get(id);
    if (entry === undefined || copy === undefined) {
      gone.push(id);
      continue;
    }
    if (copy.sha256 !== entry.sha256) {
      stale.push(id);
      continue;
    }
    try {
      registerPack(await verifyPackText(id, copy.text), copy.text);
      setStatus(id, { phase: "on" });
    } catch (error) {
      setStatus(id, {
        phase: "failed",
        reason: error instanceof Error ? error.message : "It did not restore.",
      });
    }
    await packSeams.yieldToMain();
  }
  resetSettled();
  if (gone.length > 0) {
    // A pack this build no longer has: its copy is dead weight.
    await updateStoredPacks((current) => {
      for (const id of gone) current.delete(id);
    }).catch(() => undefined);
  }
  for (const id of stale) enablePack(id);
}
