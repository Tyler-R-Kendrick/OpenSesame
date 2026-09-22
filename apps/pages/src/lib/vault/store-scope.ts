/**
 * Which tomb a vault session is scoped to, and the plaintext counters that
 * have to survive it being locked.
 *
 * Split out of `store.ts` so the store holds session behaviour rather than
 * the addressing rules underneath it. Nothing here touches a key.
 */

import { overlapCast } from "@opensesame/os-domain";
import { kvGet } from "../kv.js";
import { activeProject, scopedKey } from "../projects.js";
import { GUEST_TOMB } from "../vfs.js";

/** Lockout counters stay plaintext (ADR 0063): must work while the tomb is locked. */
export const ATTEMPTS_KEY = "vault.attempts.v1";

export const LOCK_AFTER_FAILS = 5;
export const BASE_LOCKOUT_MS = 5_000;
export const MAX_LOCKOUT_MS = 15 * 60_000;

export type VaultScope = {
  /** The active project vault's tomb — the project id, `personal` for the base vault. */
  tomb: string;
  attempts: string;
};

export function scopedVaultScope(): VaultScope {
  return {
    tomb: activeProject().id,
    attempts: scopedKey(ATTEMPTS_KEY),
  };
}

/** Guest-beside-vault tomb — isolated, throwaway, never a project id. */
export function guestVaultScope(): VaultScope {
  return {
    tomb: GUEST_TOMB,
    attempts: `${ATTEMPTS_KEY}.${GUEST_TOMB}`,
  };
}

/** A stored JSON value, or `fallback` when it is absent or unreadable. */
export function readJson<T>(key: string, fallback: T): T {
  const raw = kvGet(key);
  if (!raw) return fallback;
  try {
    return overlapCast(JSON.parse(raw));
  } catch {
    return fallback;
  }
}
