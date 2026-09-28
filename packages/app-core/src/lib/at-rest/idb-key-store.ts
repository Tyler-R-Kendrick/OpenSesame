/**
 * The browser's at-rest key store (ADR 0148).
 *
 * One IndexedDB record holds a non-extractable AES-GCM key and, sealed under
 * it, the 32-byte data key. Script can use the wrapping key but never read
 * it, so the data key exists in the clear only in this document's memory;
 * what the browser writes to disk is the wrapped copy beside a key it will
 * not export.
 *
 * Two tabs opening a fresh device at once each mint a candidate; `add` lets
 * exactly one land and the other reads the winner, so no value is ever
 * sealed under a key the next document will not have.
 */

import { type BoundaryValue, isJsonObject } from "@opensesame/os-domain";
import type { AtRestKeyPort } from "../../ports.js";
import { openOwnedDatabase } from "../../ports.js";
import { haltedWriteError, storageWritesHalted } from "../storage-halt.js";
import { AT_REST_DATABASE } from "../storage-ownership.js";
import { AT_REST_KEY_BYTES } from "./cipher.js";
import { deviceHoldsSeals } from "./sealed-evidence.js";

const VERSION = 1;
const STORE = "keys";
const RECORD = "device";
const WRAP_BINDING = new TextEncoder().encode("opensesame.at-rest.wrap.v1");

type KeyRecord = {
  id: typeof RECORD;
  wrappingKey: CryptoKey;
  iv: Uint8Array;
  wrapped: ArrayBuffer;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = openOwnedDatabase(AT_REST_DATABASE, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

/** The stored record, parsed; null for anything that is not one. */
async function read(db: IDBDatabase): Promise<KeyRecord | null> {
  const found: BoundaryValue = await request(
    db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD),
  );
  if (!isJsonObject(found) || found.id !== RECORD) return null;
  const { wrappingKey, iv, wrapped } = found;
  if (
    !(wrappingKey instanceof CryptoKey) ||
    !(iv instanceof Uint8Array) ||
    !(wrapped instanceof ArrayBuffer)
  ) {
    return null;
  }
  return { id: RECORD, wrappingKey, iv, wrapped };
}

async function mint(): Promise<KeyRecord> {
  const wrappingKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const dataKey = crypto.getRandomValues(new Uint8Array(AT_REST_KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: WRAP_BINDING },
    wrappingKey,
    dataKey,
  );
  dataKey.fill(0);
  return { id: RECORD, wrappingKey, iv, wrapped };
}

async function addOrRead(db: IDBDatabase, candidate: KeyRecord) {
  try {
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).add(candidate));
    return candidate;
  } catch (error) {
    // Another tab's candidate landed first; use it.
    const winner = await read(db);
    if (winner) return winner;
    throw error;
  }
}

async function unwrap(record: KeyRecord): Promise<Uint8Array> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv, additionalData: WRAP_BINDING },
    record.wrappingKey,
    record.wrapped,
  );
  return new Uint8Array(plain);
}

/**
 * The data key this browser keeps for this origin, minted on first use —
 * and only when `mayMint` agrees: a device that already holds seals lost its
 * key, and a new one would read everything as absent (`sealed-evidence.ts`).
 */
export async function loadIndexedDbAtRestKey(
  mayMint: () => Promise<boolean> = async () => true,
): Promise<Uint8Array> {
  // Opening alone recreates a deleted database: a tab whose browser is
  // being reset must not bring the key back.
  if (storageWritesHalted()) throw haltedWriteError();
  const db = await open();
  try {
    let record = await read(db);
    if (!record) {
      if (await mayMint()) record = await addOrRead(db, await mint());
      // The seals found may be another tab's, minted a moment ago.
      else record = await read(db);
      if (!record) throw new Error("this device holds seals whose key is gone");
    }
    return await unwrap(record);
  } finally {
    // An open connection would block "Reset this browser" from deleting it.
    db.close();
  }
}

export const indexedDbAtRestKeys: AtRestKeyPort = {
  load: () => loadIndexedDbAtRestKey(async () => !(await deviceHoldsSeals())),
};
