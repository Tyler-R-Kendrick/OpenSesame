/**
 * The wipe's intent: written before anything is removed, cleared only once
 * removal is confirmed, so a page that dies midway resumes at the next boot.
 *
 * It names vaults, not files: what is left of them is read off the device when
 * the removal resumes. The record is a journal (`store/journal.ts`) under a key
 * the core boot hydrates (`store/boot-keys.ts`); reads are synchronous, so a
 * key that was not hydrated would read as absent after a reload and the wipe
 * would never resume.
 */

import { kvGet } from "../../kv.js";
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "../json-boundary.js";
import { WIPE_INTENT_KEY, journalKeysOf } from "../store/boot-keys.js";
import {
  clearJournalDurable,
  readJournalPayload,
  writeJournal,
} from "../store/journal.js";
import { SESSION_VAULTS, isVaultName } from "./targets.js";

export type WipeIntent = Readonly<{
  v: 1;
  ids: readonly string[];
  startedAt: string;
}>;

function parse(payload: BoundaryValue): WipeIntent | null {
  if (!isJsonObject(payload)) return null;
  const { v, ids, startedAt } = payload;
  if (v !== 1 || !Array.isArray(ids) || !isString(startedAt)) return null;
  if (!ids.every(isString)) return null;
  // Whatever the record says, a session tomb is never a vault to remove.
  const named = ids.filter((id) => isVaultName(id) && !SESSION_VAULTS.has(id));
  return { v: 1, ids: named, startedAt };
}

/** The intent as written, or nothing: an unreadable or foreign one is none. */
export function readWipeIntent(): WipeIntent | null {
  return parse(readJournalPayload<BoundaryValue>(WIPE_INTENT_KEY));
}

/** Whether any record of a wipe is on this device, readable or not. */
export function wipeIntentPending(): boolean {
  return journalKeysOf(WIPE_INTENT_KEY).some((key) => kvGet(key) !== null);
}

/** Record the intent. False when storage would not take it. */
export async function writeWipeIntent(
  ids: readonly string[],
  now: Date,
): Promise<boolean> {
  const intent: WipeIntent = { v: 1, ids, startedAt: now.toISOString() };
  const written = await writeJournal(WIPE_INTENT_KEY, intent, {
    requireDurable: false,
  });
  return written.ok;
}

/** Forget the intent and wait for storage to agree. False when it will not go. */
export async function clearWipeIntent(): Promise<boolean> {
  try {
    await clearJournalDurable(WIPE_INTENT_KEY);
    return true;
  } catch {
    return false;
  }
}
