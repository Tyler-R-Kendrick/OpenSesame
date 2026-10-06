/**
 * The names an encrypted database goes by on disk (ADR 0175).
 *
 * A database's real name ("history-backups") is as telling as a column name,
 * so what the browser lists is the name run through a keyed hash: a fixed
 * prefix the ownership rule recognises (`storage-ownership.ts`, so "Reset this
 * browser" can find it) and 128 bits an observer cannot invert or link to
 * the application's own name without the device key.
 *
 * Kept apart from the rest of the library on purpose: Reset needs the names
 * and nothing else, and this file imports only the hash primitives.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { EDB_DATABASE_PREFIX } from "../storage-ownership.js";

const encoder = new TextEncoder();
export const EDB_SALT = encoder.encode("opensesame.edb.v1");

/** The logical names the app opens, so Reset can derive every one. */
export const EDB_LOGICAL_NAMES = [
  "history-backups",
  "password-history",
] as const;

export type EdbLogicalName = (typeof EDB_LOGICAL_NAMES)[number];

/** The per-device master key every other key in a database descends from. */
export function edbMasterKey(atRestKey: Uint8Array): Uint8Array {
  return hkdf(sha256, atRestKey, EDB_SALT, encoder.encode("master"), 32);
}

/** What the browser's database list shows for `logical`. */
export function edbDatabaseName(master: Uint8Array, logical: string): string {
  const nameKey = hkdf(sha256, master, EDB_SALT, encoder.encode("name"), 32);
  try {
    const digest = hmac(sha256, nameKey, encoder.encode(logical));
    return `${EDB_DATABASE_PREFIX}${bytesToHex(digest).slice(0, 32)}`;
  } finally {
    nameKey.fill(0);
  }
}

/** Every database name the app could have opened under this device key. */
export function edbKnownDatabaseNames(atRestKey: Uint8Array): string[] {
  const master = edbMasterKey(atRestKey);
  try {
    return EDB_LOGICAL_NAMES.map((logical) => edbDatabaseName(master, logical));
  } finally {
    master.fill(0);
  }
}
