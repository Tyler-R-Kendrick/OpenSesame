import { kvGet, kvSet } from "./kv.js";

const PIN_HASH_KEY = "unlockHash.v1";
/** PBKDF2 iterations — session UX unlock, not full vault KDF, but must resist offline guess. */
const PBKDF2_ITERATIONS = 210_000;
const MIN_PIN_LEN = 6;

type StoredPinV1 = {
  v: 1;
  salt: string;
  iterations: number;
  hash: string;
};

/** Tab-session unlock flag — memory only (never durable browser storage). */
let sessionUnlocked = false;

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)!;
  return out;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pbkdf2Hex(
  pin: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    256,
  );
  return [...new Uint8Array(bits)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseStored(raw: string): StoredPinV1 | { legacySha256: string } {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPinV1>;
    if (
      parsed.v === 1 &&
      typeof parsed.salt === "string" &&
      typeof parsed.hash === "string" &&
      typeof parsed.iterations === "number"
    ) {
      return {
        v: 1,
        salt: parsed.salt,
        hash: parsed.hash,
        iterations: parsed.iterations,
      };
    }
  } catch {
    /* legacy hex digest */
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return { legacySha256: raw.toLowerCase() };
  }
  throw new Error("Unlock PIN store is corrupted — clear site data and recreate.");
}

export function isUnlocked(): boolean {
  return sessionUnlocked;
}

export function hasUnlockPin(): boolean {
  return Boolean(kvGet(PIN_HASH_KEY));
}

export async function setUnlockPin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (trimmed.length < MIN_PIN_LEN) {
    throw new Error(`Use at least ${MIN_PIN_LEN} characters for the unlock PIN.`);
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2Hex(trimmed, salt, PBKDF2_ITERATIONS);
  const stored: StoredPinV1 = {
    v: 1,
    salt: bytesToB64(salt),
    iterations: PBKDF2_ITERATIONS,
    hash,
  };
  kvSet(PIN_HASH_KEY, JSON.stringify(stored));
  sessionUnlocked = true;
}

export async function unlock(pin: string): Promise<void> {
  const raw = kvGet(PIN_HASH_KEY);
  if (!raw) {
    throw new Error("No unlock PIN set yet.");
  }
  const trimmed = pin.trim();
  const stored = parseStored(raw);

  if ("legacySha256" in stored) {
    const got = await sha256Hex(trimmed);
    if (!timingSafeEqualHex(got, stored.legacySha256)) {
      throw new Error("Unlock PIN did not match.");
    }
    // Upgrade unsalted SHA-256 → salted PBKDF2 on successful unlock.
    await setUnlockPin(trimmed);
    return;
  }

  const salt = b64ToBytes(stored.salt);
  const got = await pbkdf2Hex(trimmed, salt, stored.iterations);
  if (!timingSafeEqualHex(got, stored.hash)) {
    throw new Error("Unlock PIN did not match.");
  }
  sessionUnlocked = true;
}

export function lock(): void {
  sessionUnlocked = false;
}
