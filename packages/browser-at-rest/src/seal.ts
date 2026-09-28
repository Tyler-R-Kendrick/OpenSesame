/**
 * At-rest sealing for the client plane outside the Pages app (ADR 0148): the
 * sync store's origin files, the browser extension's settings, and what the
 * relying-party SDKs keep between a sign-in and its callback.
 *
 * One non-extractable AES-GCM key per origin, kept in IndexedDB — script can
 * use it and never read it. A value is `osc1.` then base64 of a 12-byte IV
 * and the ciphertext, with the store and name bound as associated data.
 * Where no key can be kept (no IndexedDB), `sealForRest` answers null and
 * the caller keeps the value in memory: nothing is written in the clear.
 */

import { isJsonObject, overlapCast } from "@opensesame/os-domain";

export const CLIENT_AT_REST_PREFIX = "osc1.";
export const CLIENT_AT_REST_DATABASE = "opensesame-client-at-rest";

const STORE = "keys";
const RECORD = "device";

export type ClientAtRestKeys = () => Promise<CryptoKey>;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

function openKeyDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(CLIENT_AT_REST_DATABASE, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB failed"));
  });
}

async function storedKey(db: IDBDatabase): Promise<CryptoKey | null> {
  const row = await request(
    db.transaction(STORE, "readonly").objectStore(STORE).get(RECORD),
  );
  const found = overlapCast(row);
  if (!isJsonObject(found)) return null;
  const key: unknown = found.key;
  return key instanceof CryptoKey ? key : null;
}

/** The origin's key, minted on first use; two contexts minting at once agree. */
async function indexedDbKey(): Promise<CryptoKey> {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error("no IndexedDB to keep an at-rest key in");
  const db = await openKeyDatabase(factory);
  try {
    const existing = await storedKey(db);
    if (existing) return existing;
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    try {
      await request(
        db
          .transaction(STORE, "readwrite")
          .objectStore(STORE)
          .add({ id: RECORD, key }),
      );
      return key;
    } catch (error) {
      const winner = await storedKey(db);
      if (winner) return winner;
      throw error;
    }
  } finally {
    db.close();
  }
}

let keys: ClientAtRestKeys = indexedDbKey;
let cached: Promise<CryptoKey | null> | null = null;

/** Replace where the key comes from (tests, an embedder with its own). */
export function useClientAtRestKeys(next: ClientAtRestKeys): void {
  keys = next;
  cached = null;
}

function key(): Promise<CryptoKey | null> {
  cached ??= keys().catch(() => null);
  return cached;
}

function binding(store: string, name: string): Uint8Array {
  return new TextEncoder().encode(
    `opensesame.client-at-rest.v1\u0000${store}\u0000${name}`,
  );
}

function toB64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromB64(value: string): Uint8Array {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

export function isSealedForRest(value: string): boolean {
  return value.startsWith(CLIENT_AT_REST_PREFIX);
}

/** `text` sealed for `store`/`name`, or null when no key can be kept here. */
export async function sealForRest(
  store: string,
  name: string,
  text: string,
): Promise<string | null> {
  const current = await key();
  if (!current) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: binding(store, name) },
      current,
      new TextEncoder().encode(text),
    ),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv, 0);
  out.set(sealed, iv.length);
  return `${CLIENT_AT_REST_PREFIX}${toB64(out)}`;
}

/**
 * The plaintext of a stored value. One written before values were sealed
 * reads as it is; a sealed one that does not open here reads as null.
 */
export async function openFromRest(
  store: string,
  name: string,
  value: string,
): Promise<string | null> {
  if (!isSealedForRest(value)) return value;
  const current = await key();
  if (!current) return null;
  try {
    const bytes = fromB64(value.slice(CLIENT_AT_REST_PREFIX.length));
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12),
        additionalData: binding(store, name),
      },
      current,
      bytes.subarray(12),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}
