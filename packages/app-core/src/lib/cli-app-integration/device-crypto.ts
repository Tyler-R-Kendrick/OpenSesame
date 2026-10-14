/**
 * P-256 signatures for CLI app-integration pairing and approvals (Rust parity).
 */

const enc = new TextEncoder();

async function readCliAppPairingVaultSessionRoot(): Promise<string | null> {
  const { vaultStore } = await import("../vault/store.js");
  if (!vaultStore.isUnlocked()) return null;
  return vaultStore.readSessionRootDigest();
}
const DEVICE_SIGNING_STORAGE_KEY = "opensesame-cli-app-device-signing.v1";

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

export const PAIRING_CONFIRM_LABEL = "opensesame-cli-app-pairing-confirm.v1";
export const APPROVAL_CHALLENGE_LABEL = "opensesame-cli-app-approval.v1";

export async function approvalChallengeDigest(
  requestId: string,
  terminalSessionId: string,
  respondNonce: string,
  verb: string,
): Promise<Uint8Array> {
  const parts = [
    enc.encode(APPROVAL_CHALLENGE_LABEL),
    new Uint8Array([0]),
    enc.encode(requestId),
    new Uint8Array([0]),
    enc.encode(terminalSessionId),
    new Uint8Array([0]),
    enc.encode(respondNonce),
    new Uint8Array([0]),
    enc.encode(verb),
    new Uint8Array([0]),
  ];
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const msg = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    msg.set(part, off);
    off += part.byteLength;
  }
  return await sha256(msg);
}

export function pairingConfirmMessage(
  challenge: Uint8Array,
  code: string,
  origin: string,
): Uint8Array {
  const labelBytes = enc.encode(PAIRING_CONFIRM_LABEL);
  const codeBytes = enc.encode(code);
  const originBytes = enc.encode(origin);
  const msg = new Uint8Array(
    labelBytes.byteLength +
      1 +
      challenge.byteLength +
      1 +
      codeBytes.byteLength +
      1 +
      originBytes.byteLength,
  );
  let off = 0;
  msg.set(labelBytes, off);
  off += labelBytes.byteLength;
  msg[off] = 0;
  off += 1;
  msg.set(challenge, off);
  off += challenge.byteLength;
  msg[off] = 0;
  off += 1;
  msg.set(codeBytes, off);
  off += codeBytes.byteLength;
  msg[off] = 0;
  off += 1;
  msg.set(originBytes, off);
  return msg;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function b64urlDecode(value: string): Uint8Array | null {
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

export async function exportSpkiB64(publicKey: CryptoKey): Promise<string> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return b64urlEncode(spki);
}

export async function signP256Sha256B64(
  privateKey: CryptoKey,
  message: Uint8Array,
): Promise<string> {
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      message,
    ),
  );
  return b64urlEncode(sig);
}

/** CLI humanProof wire format (`oschip2:`) — loaded with device crypto only. */
export const CLI_APP_HUMAN_PROOF_PREFIX = "oschip2:";

export function formatCliAppHumanProofPin(signatureB64: string): string {
  return `${CLI_APP_HUMAN_PROOF_PREFIX}pin:${signatureB64}`;
}

export function formatCliAppHumanProofPasskey(assertionJson: string): string {
  return `${CLI_APP_HUMAN_PROOF_PREFIX}passkey:${assertionJson}`;
}

type StoredDeviceKey = Readonly<{
  publicKeySpkiB64: string;
  wrappedPkcs8B64: string;
}>;

async function deriveDeviceWrapKey(
  vaultSessionRoot: string,
): Promise<CryptoKey> {
  const rootBytes = enc.encode(vaultSessionRoot);
  const storageBytes = enc.encode(DEVICE_SIGNING_STORAGE_KEY);
  const wrapBytes = enc.encode("wrap");
  const material = new Uint8Array(
    rootBytes.byteLength +
      1 +
      storageBytes.byteLength +
      1 +
      wrapBytes.byteLength,
  );
  let off = 0;
  material.set(rootBytes, off);
  off += rootBytes.byteLength;
  material[off] = 0;
  off += 1;
  material.set(storageBytes, off);
  off += storageBytes.byteLength;
  material[off] = 0;
  off += 1;
  material.set(wrapBytes, off);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function wrapDeviceKeyMaterial(
  vaultSessionRoot: string,
  pkcs8: Uint8Array,
): Promise<string> {
  const cryptoKey = await deriveDeviceWrapKey(vaultSessionRoot);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, pkcs8),
  );
  const out = new Uint8Array(iv.byteLength + cipher.byteLength);
  out.set(iv, 0);
  out.set(cipher, iv.byteLength);
  return b64urlEncode(out);
}

async function unwrapDeviceKeyMaterial(
  vaultSessionRoot: string,
  wrappedB64: string,
): Promise<Uint8Array | null> {
  const wrapped = b64urlDecode(wrappedB64);
  if (!wrapped || wrapped.byteLength < 13) return null;
  const iv = wrapped.subarray(0, 12);
  const cipher = wrapped.subarray(12);
  try {
    const cryptoKey = await deriveDeviceWrapKey(vaultSessionRoot);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, cipher),
    );
    return plain;
  } catch {
    return null;
  }
}

function storedString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

async function readStoredDeviceKey(): Promise<StoredDeviceKey | null> {
  const { localStore } = await import("../../ports.js");
  const raw = localStore().getItem(DEVICE_SIGNING_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const publicKeySpkiB64 = storedString(record, "publicKeySpkiB64");
    const wrappedPkcs8B64 = storedString(record, "wrappedPkcs8B64");
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

async function writeStoredDeviceKey(record: StoredDeviceKey): Promise<void> {
  const { localStore } = await import("../../ports.js");
  localStore().setItem(DEVICE_SIGNING_STORAGE_KEY, JSON.stringify(record));
}

export type CliAppDeviceSigningKey = Readonly<{
  publicKeySpkiB64: string;
  sign: (message: Uint8Array) => Promise<string>;
}>;

/** Load or create the device signing key while the vault is unlocked. */
export async function ensureCliAppDeviceSigningKey(): Promise<CliAppDeviceSigningKey | null> {
  const vaultSessionRoot = await readCliAppPairingVaultSessionRoot();
  if (!vaultSessionRoot) return null;

  const stored = await readStoredDeviceKey();
  if (stored) {
    const pkcs8 = await unwrapDeviceKeyMaterial(
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
  const wrappedPkcs8B64 = await wrapDeviceKeyMaterial(vaultSessionRoot, pkcs8);
  await writeStoredDeviceKey({ publicKeySpkiB64, wrappedPkcs8B64 });
  return {
    publicKeySpkiB64,
    sign: (message) => signP256Sha256B64(keyPair.privateKey, message),
  };
}
