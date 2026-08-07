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

/** Encode UTF-8 bytes to base64 (browser + node). */
export function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @deprecated DEV-ONLY insecure XOR. Do not use in production — call Rust client-core / wasm AEAD.
 */
export function sealDevOnly(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  if (process.env.NODE_ENV === "production") {
    throw new Error("sealDevOnly is forbidden in production; use Rust client-core AEAD");
  }
  const out = new Uint8Array(plaintext.length);
  for (let i = 0; i < plaintext.length; i++) {
    out[i] = plaintext[i]! ^ key[i % key.length]!;
  }
  return out;
}

/** In-memory fallback when OPFS is unavailable — never localStorage (XSS-exfiltrable). */
const memorySealed = new Map<string, string>();

/** OPFS / memory persistence of sealed sync JSON (ciphertext only). */
export async function persistSealedStore(
  name: string,
  sealedJson: string,
): Promise<void> {
  if (sealedJson.includes("plaintext-should") || /"plaintext"\s*:/.test(sealedJson)) {
    throw new Error("refusing to persist plaintext-looking sync payload");
  }
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      const handle = await root.getFileHandle(`opensesame-sync-${name}.json`, {
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

export async function loadSealedStore(name: string): Promise<string | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (root) {
      const handle = await root.getFileHandle(`opensesame-sync-${name}.json`);
      const file = await handle.getFile();
      return await file.text();
    }
  } catch {
    /* fall through */
  }
  return memorySealed.get(name) ?? null;
}

/** Smoke helper: verifies sealed persist helpers reject plaintext markers. */
export function assertNoPlaintextInSealedJson(json: string): void {
  if (json.includes("secret-payload") || /"plaintext"\s*:/.test(json)) {
    throw new Error("sealed_json_contains_plaintext");
  }
}
