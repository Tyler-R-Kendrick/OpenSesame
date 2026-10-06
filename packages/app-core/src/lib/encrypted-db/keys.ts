/**
 * The key hierarchy of an encrypted database (ADR 0175).
 *
 * One master key per device, derived from the at-rest key, and from it a key
 * per purpose: the row seal, the pseudonyms rows and the schema's names are
 * stored under, and a key per (kind, scope) for every searchable layer. A
 * layer's key never opens another's, so a token from one column says nothing
 * about a token in another, and equal values in two columns are unlinkable
 * unless the schema joins them in a named group.
 *
 * Nothing here is stored; every key is derived again at open and zeroed at
 * close.
 */

import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { atRestBinding } from "../at-rest/cipher.js";
import {
  DEVICE_EDB_NAMESPACE,
  EDB_SALT,
  edbDatabaseName,
  edbMasterKey,
} from "./names.js";

const encoder = new TextEncoder();

/** Length-prefixed concatenation: no two part lists frame to the same bytes. */
export function frame(...parts: readonly string[]): Uint8Array {
  const encoded = parts.map((part) => encoder.encode(part));
  const out = new Uint8Array(
    encoded.reduce((size, part) => size + 4 + part.length, 0),
  );
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of encoded) {
    view.setUint32(offset, part.length);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
}

/** Why a token is minted: equality, whole words, or word prefixes. */
export type TokenKind = "eq" | "kw" | "px";

export type EdbKeys = Readonly<{
  /** What the browser lists for this database. */
  databaseName: string;
  /** The key the row seal is derived under. */
  sealKey: Uint8Array;
  /** Where the row `(table, key)` is stored: 128 bits, no name in it. */
  rowId: (table: string, key: string) => string;
  /** Where the sealed layer-state record is stored. */
  metaId: string;
  /** Associated data that pins a seal to its database and its slot. */
  binding: (slot: string) => Uint8Array;
  /** The blind index entry for `canonical` under a scope. */
  token: (kind: TokenKind, scope: string, canonical: string) => string;
  /** The tag that keeps one column's order entries apart from another's. */
  columnTag: (table: string, column: string) => string;
  /** The order-preserving key of a column. */
  opeKey: (table: string, column: string, domain: bigint) => Uint8Array;
  /** Zero every key held. */
  wipe: () => void;
}>;

function sub(master: Uint8Array, ...info: readonly string[]): Uint8Array {
  return hkdf(sha256, master, EDB_SALT, frame(...info), 32);
}

function hex128(key: Uint8Array, message: Uint8Array): string {
  return bytesToHex(hmac(sha256, key, message)).slice(0, 32);
}

/** Derive keys from the device root and a trusted customer/database context. */
export function deriveEdbKeys(
  atRestKey: Uint8Array,
  logicalName: string,
  customerNamespace = DEVICE_EDB_NAMESPACE,
): EdbKeys {
  if (customerNamespace.length === 0)
    throw new Error("Empty customer namespace");
  const master = edbMasterKey(atRestKey);
  const databaseName = edbDatabaseName(master, logicalName, customerNamespace);
  // Everything below is also bound to this database: the same device key and
  // schema in two databases share no pseudonym and no token.
  const root =
    customerNamespace === DEVICE_EDB_NAMESPACE
      ? sub(master, "database", logicalName)
      : sub(master, "customer", customerNamespace, "database", logicalName);
  master.fill(0);
  const sealKey = sub(root, "seal");
  const rowKey = sub(root, "row");
  const held: Uint8Array[] = [root, sealKey, rowKey];
  const scoped = new Map<string, Uint8Array>();

  const scopedKey = (...info: readonly string[]): Uint8Array => {
    const id = bytesToHex(frame(...info));
    const cached = scoped.get(id);
    if (cached) return cached;
    const made = sub(root, ...info);
    scoped.set(id, made);
    held.push(made);
    return made;
  };

  return {
    databaseName,
    sealKey,
    rowId: (table, key) => hex128(rowKey, frame("row", table, key)),
    metaId: hex128(rowKey, frame("meta")),
    binding: (slot) => atRestBinding(`edb.${databaseName}`, slot),
    token: (kind, scope, canonical) =>
      hex128(scopedKey("token", kind, scope), encoder.encode(canonical)),
    columnTag: (table, column) =>
      bytesToHex(
        hmac(sha256, scopedKey("tag"), frame(table, column)).subarray(0, 8),
      ),
    opeKey: (table, column, domain) =>
      scopedKey("ope", table, column, domain.toString(16)),
    wipe: () => {
      for (const key of held) key.fill(0);
      scoped.clear();
    },
  };
}
