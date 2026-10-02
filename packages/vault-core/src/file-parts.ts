/**
 * Encrypted file parts (ADR 0054's chunk size, without convergent encryption).
 *
 * The manifest is text, so it can be the native secret of a vault item. The
 * part key lives in that manifest. Ciphertext lives in an object store. Each
 * part is written to every store in the list; a read uses the first store
 * that still has it.
 */

import {
  type JsonValue,
  isJsonObject,
  isNumber,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import { b64ToBytes, bytesToB64 } from "./bytes.js";
import { importVaultKey, randomBytes } from "./crypto.js";
import { gcmOpen, gcmSeal } from "./gcm.js";

export const FILE_PART_BYTES = 1_048_576;
export const MAX_FILE_BYTES = 1_073_741_824;

export type ObjectStore = {
  putObject(key: string, body: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array | null>;
};

export type MemoryStore = ObjectStore & {
  deleteObject(key: string): Promise<void>;
  listObjects(): Promise<readonly string[]>;
};

export type FilePartRef = {
  readonly key: string;
  readonly nonce: string;
};

export type FileManifest = {
  readonly v: 1;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly key: string;
  readonly parts: readonly FilePartRef[];
};

export type SealedFile = {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
};

const MISSING = "file part is missing";

export function memoryObjectStore(): MemoryStore {
  const objects = new Map<string, Uint8Array>();
  return {
    async putObject(key, body) {
      objects.set(key, body.slice());
    },
    async getObject(key) {
      const found = objects.get(key);
      return found === undefined ? null : found.slice();
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    async listObjects() {
      return [...objects.keys()];
    },
  };
}

function wholeSize(value: JsonValue | undefined): number | undefined {
  return isNumber(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function readFileManifest(text: string): FileManifest | undefined {
  let parsed: JsonValue;
  try {
    parsed = overlapCast(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed) || parsed.v !== 1 || !Array.isArray(parsed.parts))
    return undefined;
  const name = readString(parsed.name);
  const mediaType = readString(parsed.mediaType);
  const key = readString(parsed.key);
  const size = wholeSize(parsed.size);
  if (
    name === undefined ||
    mediaType === undefined ||
    key === undefined ||
    size === undefined
  ) {
    return undefined;
  }
  const parts: FilePartRef[] = [];
  for (const entry of parsed.parts) {
    if (!isJsonObject(entry)) return undefined;
    const partKey = readString(entry.key);
    const nonce = readString(entry.nonce);
    if (partKey === undefined || nonce === undefined) return undefined;
    parts.push({ key: partKey, nonce });
  }
  return { v: 1, name, mediaType, size, key, parts };
}

/** Filename, media type and size. The part key stays inside the manifest. */
export function fileSummary(
  text: string,
): { name: string; mediaType: string; size: number } | null {
  const manifest = readFileManifest(text);
  if (manifest === undefined) return null;
  return {
    name: manifest.name,
    mediaType: manifest.mediaType,
    size: manifest.size,
  };
}

function objectKey(iv: Uint8Array): string {
  return bytesToB64(iv).replaceAll("+", "-").replaceAll("/", "_");
}

async function freshKey() {
  const raw = randomBytes(32);
  try {
    return { key: await importVaultKey(raw), encoded: bytesToB64(raw) };
  } finally {
    raw.fill(0);
  }
}

async function keyFromManifest(encoded: string): Promise<CryptoKey> {
  const raw = b64ToBytes(encoded);
  try {
    return await importVaultKey(raw);
  } finally {
    raw.fill(0);
  }
}

async function putReplicas(
  stores: readonly ObjectStore[],
  key: string,
  body: Uint8Array,
): Promise<void> {
  for (const store of stores) await store.putObject(key, body);
}

async function getReplica(
  stores: readonly ObjectStore[],
  key: string,
): Promise<Uint8Array> {
  for (const store of stores) {
    const found = await store.getObject(key);
    if (found !== null) return found;
  }
  throw new Error(MISSING);
}

async function sealOne(
  key: CryptoKey,
  bytes: Uint8Array,
  index: number,
  count: number,
  partBytes: number,
) {
  const start = index * partBytes;
  const plain = bytes.subarray(
    start,
    Math.min(start + partBytes, bytes.byteLength),
  );
  const iv = randomBytes(12);
  const body = await gcmSeal(
    key,
    plain,
    iv,
    new TextEncoder().encode(`${index}:${count}`),
  );
  return {
    ref: { key: objectKey(iv), nonce: bytesToB64(iv) },
    body,
  };
}

function partCount(length: number, partBytes: number): number {
  if (length === 0) return 0;
  return Math.ceil(length / partBytes);
}

export async function sealFile(input: {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  stores: readonly ObjectStore[];
  partBytes?: number;
  maxBytes?: number;
}): Promise<string> {
  if (input.stores.length === 0) throw new Error("file needs a store");
  const partBytes = input.partBytes ?? FILE_PART_BYTES;
  const maxBytes = input.maxBytes ?? MAX_FILE_BYTES;
  if (partBytes < 1) throw new Error(MISSING);
  if (input.bytes.byteLength > maxBytes)
    throw new Error("file exceeds the size limit");
  const { key, encoded } = await freshKey();
  const count = partCount(input.bytes.byteLength, partBytes);
  const parts: FilePartRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const sealed = await sealOne(key, input.bytes, index, count, partBytes);
    await putReplicas(input.stores, sealed.ref.key, sealed.body);
    parts.push(sealed.ref);
  }
  return JSON.stringify({
    v: 1,
    name: input.name,
    mediaType: input.mediaType,
    size: input.bytes.byteLength,
    key: encoded,
    parts,
  });
}

async function openOne(
  key: CryptoKey,
  ref: FilePartRef,
  index: number,
  count: number,
  stores: readonly ObjectStore[],
): Promise<Uint8Array> {
  const body = await getReplica(stores, ref.key);
  try {
    return await gcmOpen(
      key,
      b64ToBytes(ref.nonce),
      body,
      new TextEncoder().encode(`${index}:${count}`),
    );
  } catch (error) {
    if (error instanceof Error) throw new Error(MISSING);
    throw error;
  }
}

function joinParts(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  if (offset !== size) throw new Error(MISSING);
  return out;
}

export async function openFile(
  manifestText: string,
  stores: readonly ObjectStore[],
): Promise<SealedFile> {
  const manifest = readFileManifest(manifestText);
  if (manifest === undefined) throw new Error(MISSING);
  const key = await keyFromManifest(manifest.key);
  const count = manifest.parts.length;
  const opened: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const ref = manifest.parts[index];
    if (ref === undefined) throw new Error(MISSING);
    opened.push(await openOne(key, ref, index, count, stores));
  }
  return {
    name: manifest.name,
    mediaType: manifest.mediaType,
    bytes: joinParts(opened, manifest.size),
  };
}
