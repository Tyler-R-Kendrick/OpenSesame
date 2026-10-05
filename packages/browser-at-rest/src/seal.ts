/**
 * Browser records use fresh DEKs wrapped by independently generated,
 * non-extractable context keys held in IndexedDB. Legacy osc1 device-key seals
 * remain readable. Without durable keys, callers retain values only in memory.
 */

import { isJsonObject, overlapCast } from "@opensesame/os-domain";

export const CLIENT_AT_REST_PREFIX = "osc2.";
export const LEGACY_CLIENT_AT_REST_PREFIX = "osc1.";
export const CLIENT_AT_REST_DATABASE = "opensesame-client-at-rest";

const STORE = "keys";
const RECORD = "device";

export type ClientAtRestKeys = (context?: string) => Promise<CryptoKey>;

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

async function storedKey(
  db: IDBDatabase,
  record: string,
): Promise<CryptoKey | null> {
  const row = await request(
    db.transaction(STORE, "readonly").objectStore(STORE).get(record),
  );
  const found = overlapCast(row);
  if (!isJsonObject(found)) return null;
  const key: unknown = found.key;
  return key instanceof CryptoKey ? key : null;
}

/** The origin's key, minted on first use; two contexts minting at once agree. */
async function indexedDbKey(context?: string): Promise<CryptoKey> {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error("no IndexedDB to keep an at-rest key in");
  const db = await openKeyDatabase(factory);
  const record = context === undefined ? RECORD : `envelope:${context}`;
  try {
    const existing = await storedKey(db, record);
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
          .add({ id: record, key }),
      );
      return key;
    } catch (error) {
      const winner = await storedKey(db, record);
      if (winner) return winner;
      throw error;
    }
  } finally {
    db.close();
  }
}

let keys: ClientAtRestKeys = indexedDbKey;
const cached = new Map<string, Promise<CryptoKey | null>>();

/** Replace where the key comes from (tests, an embedder with its own). */
export function useClientAtRestKeys(next: ClientAtRestKeys): void {
  keys = next;
  cached.clear();
}

function key(context?: string): Promise<CryptoKey | null> {
  const name = context === undefined ? "legacy-device" : context;
  let pending = cached.get(name);
  if (!pending) {
    pending = keys(context).catch(() => null);
    cached.set(name, pending);
  }
  return pending;
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
  return value.startsWith("osc");
}

function context(store: string, name: string): string {
  return JSON.stringify(["opensesame.client-envelope.v2", store, name]);
}

/** Seal with a fresh data key, wrapped by the caller context's durable key. */
export async function sealForRest(
  store: string,
  name: string,
  text: string,
): Promise<string | null> {
  const scope = context(store, name);
  const current = await key(scope);
  if (!current) return null;
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const dataKey = await crypto.subtle.importKey(
      "raw",
      raw,
      "AES-GCM",
      false,
      ["encrypt"],
    );
    const aad = new TextEncoder().encode(scope);
    const wrapIv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: wrapIv, additionalData: aad },
        current,
        raw,
      ),
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const header = new Uint8Array(72);
    header.set(wrapIv);
    header.set(wrapped, 12);
    header.set(iv, 60);
    const payloadAd = new Uint8Array(aad.length + header.length);
    payloadAd.set(aad);
    payloadAd.set(header, aad.length);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: payloadAd },
        dataKey,
        new TextEncoder().encode(text),
      ),
    );
    const out = new Uint8Array(header.length + sealed.length);
    out.set(header);
    out.set(sealed, header.length);
    return `${CLIENT_AT_REST_PREFIX}${toB64(out)}`;
  } finally {
    raw.fill(0);
  }
}

async function openEnvelope(
  store: string,
  name: string,
  value: string,
): Promise<ArrayBuffer | null> {
  const scope = context(store, name);
  const current = await key(scope);
  if (!current) return null;
  const bytes = fromB64(value.slice(CLIENT_AT_REST_PREFIX.length));
  if (bytes.length < 88) return null;
  const aad = new TextEncoder().encode(scope);
  const raw = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad },
      current,
      bytes.subarray(12, 60),
    ),
  );
  try {
    if (raw.length !== 32) return null;
    const dataKey = await crypto.subtle.importKey(
      "raw",
      raw,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const payloadAd = new Uint8Array(aad.length + 72);
    payloadAd.set(aad);
    payloadAd.set(bytes.subarray(0, 72), aad.length);
    return await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(60, 72),
        additionalData: payloadAd,
      },
      dataKey,
      bytes.subarray(72),
    );
  } finally {
    raw.fill(0);
  }
}

/** Unknown or invalid sealed values fail closed; legacy plaintext remains readable. */
export async function openFromRest(
  store: string,
  name: string,
  value: string,
): Promise<string | null> {
  if (!isSealedForRest(value)) return value;
  try {
    let plain: ArrayBuffer | null;
    if (value.startsWith(CLIENT_AT_REST_PREFIX)) {
      plain = await openEnvelope(store, name, value);
    } else if (value.startsWith(LEGACY_CLIENT_AT_REST_PREFIX)) {
      const current = await key();
      if (!current) return null;
      const bytes = fromB64(value.slice(LEGACY_CLIENT_AT_REST_PREFIX.length));
      plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(0, 12),
          additionalData: binding(store, name),
        },
        current,
        bytes.subarray(12),
      );
    } else {
      return null;
    }
    return plain === null
      ? null
      : new TextDecoder("utf-8", { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}
