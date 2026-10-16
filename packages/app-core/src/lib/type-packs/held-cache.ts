/** Verified definitions needed to read actual held items; never a creation choice. */
import { packEntry } from "@opensesame/vault-item-types";
import { readStoredPacks, updateStoredPacks } from "./persist.js";

export const HELD_PACKS_KEY = "item-type-held-packs.v1";

/** Called only while installing a type the current vault actually holds. */
export function heldPackText(id: string): string | undefined {
  const entry = packEntry(id);
  const copy = readStoredPacks(HELD_PACKS_KEY).get(id);
  return entry && copy?.sha256 === entry.sha256 ? copy.text : undefined;
}

/** The installer verified these bytes against this build before keeping them. */
export async function rememberHeldPack(
  id: string,
  text: string,
): Promise<void> {
  const entry = packEntry(id);
  if (!entry) return;
  await updateStoredPacks((stored) => {
    stored.set(id, { sha256: entry.sha256, text });
  }, HELD_PACKS_KEY);
}
