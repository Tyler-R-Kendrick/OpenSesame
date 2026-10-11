/**
 * The share mnemonic (SLIP-0039, "Format of the share mnemonic"): 40 bits of
 * header (id 15, ext 1, e 4, GI 4, Gt 4, g 4, I 4, t 4), a padded share value
 * and a 30-bit RS1024 checksum, written as 10-bit words.
 */

import { Slip39Error } from "./errors.js";
import {
  CHECKSUM_WORDS,
  createChecksum,
  customizationFor,
  verifyChecksum,
} from "./rs1024.js";
import { SLIP39_WORDLIST } from "./wordlist.js";

const RADIX_BITS = 10;
const HEADER_WORDS = 4;
/** 128 bits of value, padded to 13 words, plus the header and the checksum. */
export const MIN_MNEMONIC_WORDS = HEADER_WORDS + 13 + CHECKSUM_WORDS;
const MAX_PADDING_BITS = 8;

export type ShareFields = Readonly<{
  identifier: number;
  extendable: boolean;
  iterationExponent: number;
  groupIndex: number;
  groupThreshold: number;
  groupCount: number;
  memberIndex: number;
  memberThreshold: number;
  value: Uint8Array;
}>;

let wordIndex: ReadonlyMap<string, number> | undefined;

function indexOfWord(word: string): number | undefined {
  wordIndex ??= new Map(SLIP39_WORDLIST.map((w, i) => [w, i]));
  return wordIndex.get(word);
}

function toBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function wordsOf(value: number, count: number): number[] {
  return Array.from(
    { length: count },
    (_, i) => (value >> (RADIX_BITS * (count - 1 - i))) & 1023,
  );
}

function checkRanges(f: ShareFields): void {
  const ok =
    Number.isInteger(f.identifier) &&
    f.identifier >= 0 &&
    f.identifier < 1 << 15 &&
    f.iterationExponent >= 0 &&
    f.iterationExponent <= 15 &&
    f.groupIndex >= 0 &&
    f.groupIndex < 16 &&
    f.memberIndex >= 0 &&
    f.memberIndex < 16 &&
    f.groupThreshold >= 1 &&
    f.groupThreshold <= f.groupCount &&
    f.groupCount <= 16 &&
    f.memberThreshold >= 1 &&
    f.memberThreshold <= 16;
  if (!ok) throw new Slip39Error("share fields out of range");
}

export function encodeShare(fields: ShareFields): string {
  checkRanges(fields);
  const idExp =
    (fields.identifier << 5) |
    ((fields.extendable ? 1 : 0) << 4) |
    fields.iterationExponent;
  const position =
    (fields.groupIndex << 16) |
    ((fields.groupThreshold - 1) << 12) |
    ((fields.groupCount - 1) << 8) |
    (fields.memberIndex << 4) |
    (fields.memberThreshold - 1);
  const valueWords = Math.ceil((fields.value.length * 8) / RADIX_BITS);
  const valueInt = toBigInt(fields.value);
  const value = Array.from({ length: valueWords }, (_, i) =>
    Number((valueInt >> BigInt(RADIX_BITS * (valueWords - 1 - i))) & 1023n),
  );
  const data = [...wordsOf(idExp, 2), ...wordsOf(position, 2), ...value];
  const words = [
    ...data,
    ...createChecksum(customizationFor(fields.extendable), data),
  ];
  return words.map((w) => SLIP39_WORDLIST[w]).join(" ");
}

function parseWords(mnemonic: string): number[] {
  const parts = mnemonic.trim().toLowerCase().split(/\s+/);
  return parts.map((part) => {
    const index = indexOfWord(part);
    if (index === undefined) {
      throw new Slip39Error(`"${part}" is not in the SLIP-0039 wordlist`);
    }
    return index;
  });
}

function valueFrom(words: readonly number[]): Uint8Array {
  const padding = (RADIX_BITS * words.length) % 16;
  if (padding > MAX_PADDING_BITS) {
    throw new Slip39Error("invalid mnemonic padding");
  }
  const byteCount = (RADIX_BITS * words.length - padding) / 8;
  let value = 0n;
  for (const w of words) value = (value << BigInt(RADIX_BITS)) | BigInt(w);
  if (value >> BigInt(byteCount * 8) !== 0n) {
    throw new Slip39Error("invalid mnemonic padding");
  }
  const out = new Uint8Array(byteCount);
  for (let i = byteCount - 1; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

export function decodeShare(mnemonic: string): ShareFields {
  const words = parseWords(mnemonic);
  if (words.length < MIN_MNEMONIC_WORDS) {
    throw new Slip39Error(
      `a share is at least ${MIN_MNEMONIC_WORDS} words, not ${words.length}`,
    );
  }
  const idExp = ((words[0] ?? 0) << 10) | (words[1] ?? 0);
  const extendable = ((idExp >> 4) & 1) === 1;
  if (!verifyChecksum(customizationFor(extendable), words)) {
    throw new Slip39Error("invalid mnemonic checksum");
  }
  const position = ((words[2] ?? 0) << 10) | (words[3] ?? 0);
  const fields: ShareFields = {
    identifier: idExp >> 5,
    extendable,
    iterationExponent: idExp & 15,
    groupIndex: (position >> 16) & 15,
    groupThreshold: ((position >> 12) & 15) + 1,
    groupCount: ((position >> 8) & 15) + 1,
    memberIndex: (position >> 4) & 15,
    memberThreshold: (position & 15) + 1,
    value: valueFrom(words.slice(HEADER_WORDS, -CHECKSUM_WORDS)),
  };
  if (fields.groupThreshold > fields.groupCount) {
    throw new Slip39Error("group threshold exceeds group count");
  }
  return fields;
}
