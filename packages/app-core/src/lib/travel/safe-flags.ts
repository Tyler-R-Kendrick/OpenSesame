/**
 * Which vaults the owner has marked safe to carry (ADR 0143).
 *
 * A device setting, remembered across reloads, so the choice is made once
 * — at home, unhurried — and not again at the border. It names vault ids
 * and nothing else, and is sealed under the device key like every file the
 * origin keeps. A vault that has left, or been deleted, drops out on read:
 * a stale id would otherwise mark a vault safe that a later return brings
 * back under the same name.
 */

import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import { kvGet, kvSetDurable } from "../kv.js";

export const TRAVEL_SAFE_KEY = "travel.safe.v1";

/** The ids marked safe, kept only where `present` still lists them. */
export function readSafeFlags(present: readonly string[]): Set<string> {
  const raw = kvGet(TRAVEL_SAFE_KEY);
  if (raw === null) return new Set();
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    const ids = isJsonObject(parsed) ? parsed.safe : null;
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.map(String).filter((id) => present.includes(id)));
  } catch {
    return new Set();
  }
}

/** Remember the set. Best effort: a browser that will not keep it says so elsewhere. */
export async function writeSafeFlags(safe: ReadonlySet<string>): Promise<void> {
  await kvSetDurable(
    TRAVEL_SAFE_KEY,
    JSON.stringify({ safe: [...safe].sort() }),
  );
}
