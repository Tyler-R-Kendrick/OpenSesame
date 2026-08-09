import { kvDelete, kvGet, kvSet } from "./kv.js";

const PIN_HASH_KEY = "unlockHash.v1";
const ATTEMPT_KEY = "unlockAttempts.v1";
/** PBKDF2 iterations — session UX unlock, not full vault KDF, but must resist offline guess. */
const PBKDF2_ITERATIONS = 210_000;
const MIN_PIN_LEN = 6;
/** Failures before progressive lockout starts. */
const LOCK_AFTER_FAILS = 3;
const BASE_LOCK_MS = 2_000;
const MAX_LOCK_MS = 15 * 60_000;
/**
 * A stored record names its own KDF parameters, and storage is not a place that
 * earns trust. Below the floor the record is too cheap to guess against and gets
 * re-derived on the next successful unlock; above the ceiling deriving it would
 * simply hang the tab, which is a lockout by another name.
 */
const MIN_ACCEPTED_ITERATIONS = 100_000;
const MAX_ACCEPTED_ITERATIONS = 5_000_000;
const MIN_SALT_BYTES = 16;

type AttemptState = { fails: number; lockedUntil: number };

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
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new Error(
      "Unlock PIN store is corrupted — clear site data and recreate.",
    );
  }
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
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    parsedJson = undefined;
  }
  if (parsedJson !== undefined) {
    const parsed = parsedJson as Partial<StoredPinV1>;
    if (
      parsed.v === 1 &&
      typeof parsed.salt === "string" &&
      typeof parsed.hash === "string" &&
      typeof parsed.iterations === "number" &&
      Number.isInteger(parsed.iterations)
    ) {
      if (
        parsed.iterations < 1 ||
        parsed.iterations > MAX_ACCEPTED_ITERATIONS
      ) {
        throw new Error(
          "Unlock PIN store is corrupted — clear site data and recreate.",
        );
      }
      return {
        v: 1,
        salt: parsed.salt,
        hash: parsed.hash,
        iterations: parsed.iterations,
      };
    }
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    return { legacySha256: raw.toLowerCase() };
  }
  throw new Error(
    "Unlock PIN store is corrupted — clear site data and recreate.",
  );
}

function readAttempts(): AttemptState {
  try {
    const raw = kvGet(ATTEMPT_KEY);
    if (!raw) return { fails: 0, lockedUntil: 0 };
    const parsed = JSON.parse(raw) as Partial<AttemptState>;
    // A stored deadline is bounded on the way in: a planted or clock-skewed value
    // must not be able to lock a person out of their own vault indefinitely.
    const lockedUntil =
      typeof parsed.lockedUntil === "number" &&
      Number.isFinite(parsed.lockedUntil)
        ? Math.min(parsed.lockedUntil, Date.now() + MAX_LOCK_MS)
        : 0;
    return {
      fails:
        typeof parsed.fails === "number" && parsed.fails > 0 ? parsed.fails : 0,
      lockedUntil,
    };
  } catch {
    return { fails: 0, lockedUntil: 0 };
  }
}

function clearAttempts(): void {
  kvDelete(ATTEMPT_KEY);
}

function assertNotLocked(): void {
  const { lockedUntil } = readAttempts();
  const now = Date.now();
  if (lockedUntil > now) {
    const secs = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
    throw new Error(`Too many unlock attempts. Try again in ${secs}s.`);
  }
}

function recordFailure(): void {
  const prev = readAttempts();
  const fails = prev.fails + 1;
  let lockedUntil = 0;
  if (fails >= LOCK_AFTER_FAILS) {
    const exp = Math.min(fails - LOCK_AFTER_FAILS, 12);
    lockedUntil = Date.now() + Math.min(BASE_LOCK_MS * 2 ** exp, MAX_LOCK_MS);
  }
  kvSet(ATTEMPT_KEY, JSON.stringify({ fails, lockedUntil }));
}

export function isUnlocked(): boolean {
  return sessionUnlocked;
}

export function hasUnlockPin(): boolean {
  return Boolean(kvGet(PIN_HASH_KEY));
}

/**
 * Set the PIN. Replacing an existing PIN is a re-key, so it takes an unlocked
 * session: otherwise being locked out is escaped by simply choosing a new PIN,
 * which would also reset the lockout.
 */
export async function setUnlockPin(pin: string): Promise<void> {
  if (hasUnlockPin() && !sessionUnlocked) {
    throw new Error("Unlock with the current PIN before changing it.");
  }
  await writePin(pin);
}

/** Write a PIN record at today's cost. Callers own the decision to allow it. */
async function writePin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (trimmed.length < MIN_PIN_LEN) {
    throw new Error(
      `Use at least ${MIN_PIN_LEN} characters for the unlock PIN.`,
    );
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
  clearAttempts();
  sessionUnlocked = true;
}

export async function unlock(pin: string): Promise<void> {
  assertNotLocked();
  const raw = kvGet(PIN_HASH_KEY);
  if (!raw) {
    throw new Error("No unlock PIN set yet.");
  }
  const trimmed = pin.trim();
  const stored = parseStored(raw);

  if ("legacySha256" in stored) {
    const got = await sha256Hex(trimmed);
    if (!timingSafeEqualHex(got, stored.legacySha256)) {
      recordFailure();
      throw new Error("Unlock PIN did not match.");
    }
    // Upgrade unsalted SHA-256 → salted PBKDF2 on successful unlock.
    await writePin(trimmed);
    return;
  }

  const salt = b64ToBytes(stored.salt);
  if (salt.length < MIN_SALT_BYTES) {
    throw new Error(
      "Unlock PIN store is corrupted — clear site data and recreate.",
    );
  }
  const got = await pbkdf2Hex(trimmed, salt, stored.iterations);
  if (!timingSafeEqualHex(got, stored.hash)) {
    recordFailure();
    throw new Error("Unlock PIN did not match.");
  }
  clearAttempts();
  sessionUnlocked = true;
  if (stored.iterations < MIN_ACCEPTED_ITERATIONS) {
    // Accepted this once so nobody is locked out of their own vault, then written
    // back at today's cost so the next guess is priced properly.
    await writePin(trimmed);
  }
}

/** Re-key: proves the current PIN, then replaces it. */
export async function changeUnlockPin(
  currentPin: string,
  nextPin: string,
): Promise<void> {
  await unlock(currentPin);
  await setUnlockPin(nextPin);
}

export function lock(): void {
  sessionUnlocked = false;
}
