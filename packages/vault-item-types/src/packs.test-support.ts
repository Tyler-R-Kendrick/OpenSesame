import { loadPack, packEntries } from "./packs.js";

/** Load every pack, so a test sees the whole built-in corpus. */
export async function loadEveryPack(): Promise<void> {
  await Promise.all(packEntries().map((entry) => loadPack(entry.id)));
}
