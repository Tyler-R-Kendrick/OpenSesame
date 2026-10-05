/**
 * The hold a "freeze" duress code leaves on this device (ADR 0168).
 *
 * One journal record, `{ until, setAt }`, in epoch milliseconds of THIS
 * device's clock, sealed at rest by the kv layer like every other value.
 *
 * - Extend only. A later freeze may push `until` out, never pull it in, and
 *   nothing here removes a record: there is no owner-clear and no UI for one.
 *   An expired record is simply ignored, and the next freeze replaces it.
 * - A record that is not exactly this shape, or that asks for longer than the
 *   longest choice, is not a hold. A corrupted record must not lock the owner
 *   out forever, so reading it fails open.
 * - The clock is the device's. A changed clock changes the hold, and clearing
 *   site data ends it; this stops someone using the app as it is, not someone
 *   who controls the browser's storage.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
} from "../json-boundary.js";
import { HOLD_KEY } from "../store/boot-keys.js";
import { readJournalPayload, writeJournal } from "../store/journal.js";

export const HOUR_MS = 3_600_000;

/** The durations the sheet offers, in hours; nothing else is a freeze. */
export const FREEZE_HOURS = [1, 24, 72] as const;

/** The longest a record may hold: the longest choice. */
export const MAX_HOLD_MS = 72 * HOUR_MS;

export type HoldRecord = Readonly<{ until: number; setAt: number }>;

/** The record, or nothing when it is absent or not a well-formed hold. */
export function readHold(): HoldRecord | null {
  const payload = readJournalPayload<BoundaryValue>(HOLD_KEY);
  if (!isJsonObject(payload)) return null;
  const { until, setAt } = payload;
  if (!isNumber(until) || !isNumber(setAt)) return null;
  if (!Number.isFinite(until) || !Number.isFinite(setAt)) return null;
  if (until <= setAt || until - setAt > MAX_HOLD_MS) return null;
  return { until, setAt };
}

/** Whether `hours` is one of the offered durations. */
export function isFreezeHours(hours: BoundaryValue): hours is 1 | 24 | 72 {
  return FREEZE_HOURS.some((choice) => choice === hours);
}

/**
 * Hold the device until `hours` from now, if that is later than any hold it
 * already has. Never throws: a write storage refuses records nothing, and the
 * code that asked for it has already been typed under duress, so there is
 * nothing to tell anyone. Returns whether a record was written.
 */
export async function extendHold(
  hours: BoundaryValue,
  now: () => number = Date.now,
): Promise<boolean> {
  if (!isFreezeHours(hours)) return false;
  try {
    const setAt = now();
    const until = setAt + hours * HOUR_MS;
    const held = readHold();
    if (held && held.until >= until) return false;
    const result = await writeJournal<HoldRecord>(HOLD_KEY, { until, setAt });
    return result.ok;
  } catch {
    return false;
  }
}
