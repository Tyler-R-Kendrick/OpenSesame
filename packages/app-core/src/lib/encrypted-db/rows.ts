/**
 * A row as the disk holds it: one sealed string and the index entries that
 * were computed from it (ADR 0175).
 *
 * The table, the key and every field are inside the seal, which is bound to
 * the pseudonym the row is stored under, so a row moved to another slot, or
 * another database, opens as nothing. The plaintext is padded before sealing
 * (Padme, Nikitin et al. 2019) to a length that reveals at most a few bits
 * of the real one, and never to less than `MIN_PADDED` bytes: a short id and
 * a long one occupy the same record.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { openAtRest, sealAtRest } from "../at-rest/cipher.js";
import type { IndexKey } from "./entries.js";
import type { EdbKeys } from "./keys.js";
import type { EdbRow } from "./schema.js";

export const MIN_PADDED = 256;
const FORMAT = 1;
const encoder = new TextEncoder();

/** What a record holds in IndexedDB: the seal, and the index's entries. */
export type StoredRow = { c: string; x: IndexKey[] };

export type OpenedRow = Readonly<{
  table: string;
  key: string;
  row: EdbRow;
}>;

/** The Padme length for `length` bytes: at most 12% longer, fewer distinct sizes. */
export function padmeLength(length: number): number {
  if (length < 2) return length;
  const exponent = 31 - Math.clz32(length);
  const significant = 31 - Math.clz32(exponent) + 1;
  const mask = (1 << (exponent - significant)) - 1;
  return (length + mask) & ~mask;
}

/** Seal text padded with the whitespace JSON ignores. */
export function sealPadded(
  keys: EdbKeys,
  slot: string,
  document: string,
): string {
  const size = encoder.encode(document).length;
  const target = Math.max(MIN_PADDED, padmeLength(size));
  return sealAtRest(
    keys.sealKey,
    keys.binding(slot),
    document + " ".repeat(target - size),
  );
}

export function openSealed(
  keys: EdbKeys,
  slot: string,
  sealed: string,
): BoundaryValue {
  const text = openAtRest(keys.sealKey, keys.binding(slot), sealed);
  if (text === null) return null;
  try {
    const parsed: BoundaryValue = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

export function sealRow(
  keys: EdbKeys,
  table: string,
  key: string,
  row: EdbRow,
): string {
  return sealPadded(
    keys,
    keys.rowId(table, key),
    JSON.stringify({ v: FORMAT, t: table, k: key, r: row }),
  );
}

/** The row stored at `slot`; null when it is not one this database wrote there. */
export function openRow(
  keys: EdbKeys,
  slot: string,
  sealed: string,
): OpenedRow | null {
  const body = openSealed(keys, slot, sealed);
  if (
    !isJsonObject(body) ||
    body.v !== FORMAT ||
    !isString(body.t) ||
    !isString(body.k) ||
    !isJsonObject(body.r) ||
    keys.rowId(body.t, body.k) !== slot
  ) {
    return null;
  }
  return { table: body.t, key: body.k, row: body.r };
}
