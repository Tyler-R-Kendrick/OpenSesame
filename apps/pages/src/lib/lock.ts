import { kvGet, kvSet } from "./kv.js";

const PIN_HASH_KEY = "unlockHash.v1";

/** Tab-session unlock flag — memory only (never durable browser storage). */
let sessionUnlocked = false;

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isUnlocked(): boolean {
  return sessionUnlocked;
}

export function hasUnlockPin(): boolean {
  return Boolean(kvGet(PIN_HASH_KEY));
}

export async function setUnlockPin(pin: string): Promise<void> {
  const trimmed = pin.trim();
  if (trimmed.length < 4) {
    throw new Error("Use at least 4 characters for the unlock PIN.");
  }
  kvSet(PIN_HASH_KEY, await sha256Hex(trimmed));
  sessionUnlocked = true;
}

export async function unlock(pin: string): Promise<void> {
  const expected = kvGet(PIN_HASH_KEY);
  if (!expected) {
    throw new Error("No unlock PIN set yet.");
  }
  const got = await sha256Hex(pin.trim());
  if (got !== expected) {
    throw new Error("Unlock PIN did not match.");
  }
  sessionUnlocked = true;
}

export function lock(): void {
  sessionUnlocked = false;
}
