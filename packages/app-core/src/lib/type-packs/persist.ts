/**
 * The packs this device has switched on, kept so they survive a reload and
 * work offline (ADR 0164).
 *
 * The definition text is stored beside its digest, sealed at rest like every
 * other value the client keeps (ADR 0149). On the next boot a pack is
 * registered from this copy with no request at all; the digest is checked
 * against the build's index first, so a stored copy of an older definition is
 * refetched, never trusted.
 */

import {
  type JsonValue,
  isString,
  readJsonObject,
} from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "../kv.js";

export const PACKS_KEY = "item-type-packs.v1";

export type StoredPack = Readonly<{ sha256: string; text: string }>;

/** What `readStoredPacks` answers: a copy, so a caller cannot edit the store. */
export function readStoredPacks(): Map<string, StoredPack> {
  const out = new Map<string, StoredPack>();
  const raw = kvGet(PACKS_KEY);
  if (raw === null) return out;
  try {
    const parsed: JsonValue = JSON.parse(raw);
    const packs = readJsonObject(readJsonObject(parsed)?.packs);
    for (const [id, value] of Object.entries(packs ?? {})) {
      const pack = readJsonObject(value);
      const sha256 = pack?.sha256;
      const text = pack?.text;
      if (sha256 !== undefined && text !== undefined) {
        if (isString(sha256) && isString(text)) out.set(id, { sha256, text });
      }
    }
  } catch {
    // Unreadable is empty: every pack is fetched again, nothing is lost.
  }
  return out;
}

/** Writes are chained so two changes never interleave their read-modify-write. */
let writes: Promise<void> = Promise.resolve();

export function updateStoredPacks(
  change: (current: Map<string, StoredPack>) => void,
): Promise<void> {
  const run = async () => {
    const next = readStoredPacks();
    change(next);
    await kvSetDurable(
      PACKS_KEY,
      JSON.stringify({ v: 1, packs: Object.fromEntries(next) }),
    );
  };
  const result = writes.then(run, run);
  writes = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
