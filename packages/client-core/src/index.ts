/**
 * TypeScript façade mirroring `crates/client-core` sync shapes.
 * Full AEAD: prefer Rust wasm (`wasm-bindgen` feature) when loaded; OPFS stores ciphertext only.
 */

export interface SyncCursor {
  deviceId: string;
  epoch: number;
}

export interface SyncBlob {
  id: string;
  epoch: number;
  /** Base64 ciphertext — never plaintext */
  ciphertextB64: string;
}

export function createCursor(deviceId: string): SyncCursor {
  return { deviceId, epoch: 0 };
}

function latin1FromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Encode UTF-8 bytes to base64 (browser + node via global btoa). */
export function bytesToB64(bytes: Uint8Array): string {
  return btoa(latin1FromBytes(bytes));
}

export function b64ToBytes(b64: string): Uint8Array {
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error("not base64");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * True only when this is demonstrably a development or test run.
 *
 * A browser bundle has no `process.env`, so asking "is this production?" answered
 * "no" in exactly the environment that matters and the XOR below ran anyway. Ask
 * the opposite question instead: an environment that cannot prove it is dev is
 * treated as production.
 */
function isDevOrTestEnv(): boolean {
  const g = globalThis as {
    process?: { env?: { NODE_ENV?: string } };
    __OPENSESAME_ALLOW_DEV_SEAL__?: boolean;
  };
  if (g.__OPENSESAME_ALLOW_DEV_SEAL__ === true) return true;
  const nodeEnv = g.process?.env?.NODE_ENV;
  return nodeEnv === "development" || nodeEnv === "test";
}

/**
 * @deprecated DEV-ONLY insecure XOR. Do not use in production — call Rust client-core / wasm AEAD.
 */
export function sealDevOnly(
  plaintext: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  if (!isDevOrTestEnv()) {
    throw new Error(
      "sealDevOnly is forbidden outside dev/test; use Rust client-core AEAD",
    );
  }
  if (key.length === 0) {
    throw new Error("sealDevOnly requires a key");
  }
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    out[i] = plaintext[i]! ^ key[i % key.length]!;
  }
  return out;
}

/** In-memory fallback when OPFS is unavailable — never localStorage (XSS-exfiltrable). */
const memorySealed = new Map<string, string>();

/**
 * The sealed store on disk is exactly this and nothing else: a cursor naming the
 * device and its epoch, plus blobs whose payload is base64 ciphertext.
 *
 * Checking the shape is what makes "ciphertext only" a claim rather than a hope.
 * The previous guard searched the JSON for the word `plaintext` and for a string
 * used by its own test, so a real vault document — which contains neither — went
 * straight to disk.
 */
export interface SealedStore {
  cursor: { device_id: string; epoch: number };
  blobs: Array<{ id: string; epoch: number; ciphertextB64: string }>;
}

const MAX_SEALED_BLOBS = 4096;
const MAX_DEVICE_ID_LENGTH = 128;
const MAX_BLOB_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function safeId(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > max) return null;
  return SAFE_ID.test(value) ? value : null;
}

function epoch(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return null;
  return value;
}

/** Parse a sealed store, or null when the document is not one. */
export function parseSealedStore(json: string): SealedStore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return null;
  const row = parsed as Record<string, unknown>;
  // Unknown keys are where a plaintext document would hide, so there are none.
  for (const key of Object.keys(row)) {
    if (key !== "cursor" && key !== "blobs") return null;
  }
  const cursorRow = row.cursor;
  if (typeof cursorRow !== "object" || cursorRow === null) return null;
  const cursorFields = cursorRow as Record<string, unknown>;
  for (const key of Object.keys(cursorFields)) {
    if (key !== "device_id" && key !== "epoch") return null;
  }
  const deviceId = safeId(cursorFields.device_id, MAX_DEVICE_ID_LENGTH);
  const cursorEpoch = epoch(cursorFields.epoch);
  if (deviceId === null || cursorEpoch === null) return null;
  if (!Array.isArray(row.blobs) || row.blobs.length > MAX_SEALED_BLOBS)
    return null;

  const blobs: SealedStore["blobs"] = [];
  for (const entry of row.blobs) {
    if (typeof entry !== "object" || entry === null) return null;
    const blob = entry as Record<string, unknown>;
    for (const key of Object.keys(blob)) {
      if (key !== "id" && key !== "epoch" && key !== "ciphertextB64")
        return null;
    }
    const id = safeId(blob.id, MAX_BLOB_ID_LENGTH);
    const blobEpoch = epoch(blob.epoch);
    if (id === null || blobEpoch === null) return null;
    if (
      typeof blob.ciphertextB64 !== "string" ||
      !BASE64.test(blob.ciphertextB64)
    ) {
      return null;
    }
    blobs.push({ id, epoch: blobEpoch, ciphertextB64: blob.ciphertextB64 });
  }
  return { cursor: { device_id: deviceId, epoch: cursorEpoch }, blobs };
}

/** One file per device, and the name cannot leave the directory it belongs in. */
function sealedFileName(name: string): string {
  return `opensesame-sync-${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

/** OPFS / memory persistence of sealed sync JSON (ciphertext only). */
export async function persistSealedStore(
  name: string,
  sealedJson: string,
): Promise<void> {
  const parsed = parseSealedStore(sealedJson);
  if (parsed === null) {
    throw new Error("refusing to persist a payload that is not a sealed store");
  }
  // A store is bound to the device it belongs to. Without this a well-formed file
  // copied from another profile is adopted whole — its device id and epoch become
  // this client's, which is an identity handed over by a file copy.
  if (parsed.cursor.device_id !== name) {
    throw new Error("refusing to persist a sealed store for another device");
  }
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      const handle = await root.getFileHandle(sealedFileName(name), {
        create: true,
      });
      const writable = await handle.createWritable();
      await writable.write(sealedJson);
      await writable.close();
      return;
    }
  } catch {
    /* fall through */
  }
  memorySealed.set(name, sealedJson);
}

/**
 * Read the sealed store, or null when what is there is not one.
 *
 * A half-written file or a planted one must not be handed back: callers read the
 * device id and epoch out of this and adopt them, so an unusable file is treated
 * as absent and replaced rather than trusted.
 */
export async function loadSealedStore(name: string): Promise<string | null> {
  // Bound to the device asking, not merely well formed: a store naming another
  // device is somebody else's, however intact it looks.
  const forThisDevice = (text: string): string | null => {
    const parsed = parseSealedStore(text);
    if (parsed === null) return null;
    return parsed.cursor.device_id === name ? text : null;
  };
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      const handle = await root.getFileHandle(sealedFileName(name));
      const file = await handle.getFile();
      return forThisDevice(await file.text());
    }
  } catch {
    /* fall through */
  }
  const held = memorySealed.get(name) ?? null;
  return held === null ? null : forThisDevice(held);
}

/**
 * Assert a document is a sealed store — i.e. that it carries nothing but a cursor
 * and base64 blobs. Anything else is, by definition here, unsealed content.
 */
export function assertNoPlaintextInSealedJson(json: string): void {
  if (parseSealedStore(json) === null) {
    throw new Error("sealed_json_contains_plaintext");
  }
}
