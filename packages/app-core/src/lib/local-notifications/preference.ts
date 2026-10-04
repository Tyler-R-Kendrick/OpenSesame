/**
 * The person's preference for where this device tells them a request is
 * waiting (ADR 0162): an ordered list of places, sealed in the vault.
 *
 * It is a preference, not a policy. It names places in the order the person
 * would like them and may leave some out, and `effectiveDestinations`
 * (`destinations.ts`) narrows it to what this device allows. It has no field
 * that could widen anything, so it cannot: the file's schema is the whole of
 * what a write can say. The in-app place is always named, because the inbox
 * cannot be turned off, and a file that leaves it out is refused rather than
 * quietly given it back.
 *
 * The same text is the Settings form's state and the Settings file
 * `settings/capabilities/local-notifications.json` (ADR 0134): both write
 * through `writePreference`, so the same refusals meet both.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "../kv.js";
import { VfsError, readFile, tombFileKey, writeFile } from "../vfs.js";
import { LOCAL_DESTINATIONS, type LocalDestination } from "./destinations.js";

const PATH = "config/local-notifications";
const MAX_BYTES = 4096;

export type LocalPreference = Readonly<{
  version: 1;
  destinations: readonly LocalDestination[];
}>;

/** Every place, in the order the doorbells are most to least intrusive. */
export const DEFAULT_PREFERENCE: LocalPreference = {
  version: 1,
  destinations: ["in_app", "tab_title", "system"],
};

export type PreferenceRead =
  | { ok: true; preference: LocalPreference }
  | { ok: false; error: string };

function isDestination(value: BoundaryValue): value is LocalDestination {
  return LOCAL_DESTINATIONS.some((destination) => destination === value);
}

/** Read a preference from text. The first thing wrong is the one answered. */
export function parsePreference(raw: string): PreferenceRead {
  if (raw.length > MAX_BYTES)
    return { ok: false, error: "The preference is too large." };
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "The preference is not valid JSON." };
  }
  if (!isJsonObject(parsed) || parsed.version !== 1)
    return { ok: false, error: "The preference must be a version 1 object." };
  for (const key of Object.keys(parsed))
    if (key !== "version" && key !== "destinations")
      return { ok: false, error: `Unknown field "${key}".` };
  const { destinations } = parsed;
  if (!Array.isArray(destinations) || destinations.length === 0)
    return { ok: false, error: "destinations must list at least one place." };
  const chosen: LocalDestination[] = [];
  for (const destination of destinations) {
    if (!isDestination(destination))
      return {
        ok: false,
        error: `${isString(destination) ? `"${destination}"` : "That"} is not a place a notice can go.`,
      };
    if (chosen.includes(destination))
      return { ok: false, error: `"${destination}" is listed twice.` };
    chosen.push(destination);
  }
  if (!chosen.includes("in_app"))
    return {
      ok: false,
      error: "in_app cannot be left out: the inbox is always on.",
    };
  return { ok: true, preference: { version: 1, destinations: chosen } };
}

/** The canonical text of a preference: what the file shows and the form writes. */
export function serializePreference(preference: LocalPreference): string {
  return `${JSON.stringify(preference, null, 2)}\n`;
}

const listeners = new Set<() => void>();

/** Be told when this tab changed the preference. Returns the unsubscribe. */
export function subscribePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The vault's preference, or the default where it has none or holds one this
 * build cannot read: a notice must still reach the person, so an unreadable
 * file falls back to every place policy allows rather than to silence.
 */
export async function readPreference(tomb: string): Promise<LocalPreference> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    const read = parsePreference(new TextDecoder().decode(bytes));
    return read.ok ? read.preference : DEFAULT_PREFERENCE;
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found")
      return DEFAULT_PREFERENCE;
    throw error;
  }
}

/** Seal a preference in the vault and tell this tab's listeners. */
export async function writePreference(
  tomb: string,
  preference: LocalPreference,
): Promise<void> {
  const text = serializePreference(preference);
  // The same refusals as the file: nothing is written that would not read back.
  const read = parsePreference(text);
  if (!read.ok) throw new Error(read.error);
  await writeFile(tomb, PATH, new TextEncoder().encode(text));
  for (const listener of [...listeners]) listener();
}
