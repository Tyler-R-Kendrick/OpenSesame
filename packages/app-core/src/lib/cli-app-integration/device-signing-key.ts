/**
 * Per-device P-256 signing key for CLI app-integration (vault-wrapped at rest).
 */

import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import { exportSpkiB64 } from "./device-crypto.js";
import { readCliAppPairingVaultSessionRoot } from "./vault-session-root.js";

const STORAGE_KEY = "opensesame-cli-app-device-signing.v1";
const enc = new TextEncoder();

type StoredDeviceKey = Readonly<{
  publicKeySpkiB64: string;
  wrappedPkcs8B64: string;
}>;

function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function b64urlDecode(value: string): Uint8Array | null {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(pad));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

async function deriveWrapKey(vaultSessionRoot: string): Promise<CryptoKey> {
  const material = new Uint8Array(
    enc.encode(vaultSessionRoot).byteLength +
      1 +
      enc.encode(STORAGE_KEY).byteLength +
      1 +
      enc.encode("wrap").byteLength,
  );
  let off = 0;
  const rootBytes = enc.encode(vaultSessionRoot);
  material.set(rootBytes, off);
  off += rootBytes.byteLength;
  material[off] = 0;
  off += 1;
  const storageBytes = enc.encode(STORAGE_KEY);
  material.set(storageBytes, off);
  off += storageBytes.byteLength;
  material[off] = 0;
  off += 1;
  material.set(enc.encode("wrap"), off);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function wrapKeyMaterial(
  vaultSessionRoot: string,
  pkcs8: Uint8Array,
): Promise<string> {
  const cryptoKey = await deriveWrapKey(vaultSessionRoot);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, pkcs8),
  );
  const out = new Uint8Array(iv.byteLength + cipher.byteLength);
  out.set(iv, 0);
  out.set(cipher, iv.byteLength);
  return b64urlEncode(out);
}

async function unwrapKeyMaterial(
  vaultSessionRoot: string,
  wrappedB64: string,
): Promise<Uint8Array | null> {
  const wrapped = b64urlDecode(wrappedB64);
  if (!wrapped || wrapped.byteLength < 13) return null;
  const iv = wrapped.subarray(0, 12);
  const cipher = wrapped.subarray(12);
  try {
    const cryptoKey = await deriveWrapKey(vaultSessionRoot);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, cipher),
    );
    return plain;
  } catch {
    return null;
  }
}

async function readStored(): Promise<StoredDeviceKey | null> {
  const { localStore } = await import("../../ports.js");
  const raw = localStore().getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: BoundaryValue = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed)) return null;
    const publicKeySpkiB64 = readString(parsed.publicKeySpkiB64);
    const wrappedPkcs8B64 = readString(parsed.wrappedPkcs8B64);
    if (!publicKeySpkiB64 || !wrappedPkcs8B64) {
      return null;
    }
    return {
      publicKeySpkiB64,
      wrappedPkcs8B64,
    };
  } catch {
    return null;
  }
}

async function writeStored(record: StoredDeviceKey): Promise<void> {
  const { localStore } = await import("../../ports.js");
  localStore().setItem(STORAGE_KEY, JSON.stringify(record));
}

export type CliAppDeviceSigningKey = Readonly<{
  publicKeySpkiB64: string;
  sign: (message: Uint8Array) => Promise<string>;
}>;

/** Load or create the device signing key while the vault is unlocked. */
export async function ensureCliAppDeviceSigningKey(): Promise<CliAppDeviceSigningKey | null> {
  const vaultSessionRoot = await readCliAppPairingVaultSessionRoot();
  if (!vaultSessionRoot) return null;

  const stored = await readStored();
  if (stored) {
    const pkcs8 = await unwrapKeyMaterial(
      vaultSessionRoot,
      stored.wrappedPkcs8B64,
    );
    if (!pkcs8) return null;
    try {
      const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        pkcs8,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const { signP256Sha256B64 } = await import("./device-crypto.js");
      return {
        publicKeySpkiB64: stored.publicKeySpkiB64,
        sign: (message) => signP256Sha256B64(privateKey, message),
      };
    } catch {
      return null;
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
  );
  const publicKeySpkiB64 = await exportSpkiB64(keyPair.publicKey);
  const wrappedPkcs8B64 = await wrapKeyMaterial(vaultSessionRoot, pkcs8);
  await writeStored({ publicKeySpkiB64, wrappedPkcs8B64 });
  const { signP256Sha256B64 } = await import("./device-crypto.js");
  return {
    publicKeySpkiB64,
    sign: (message) => signP256Sha256B64(keyPair.privateKey, message),
  };
}
