/**
 * The failed-unlock counter and its lockout (ADR 0063), kept out of
 * `store.ts` so the store line budget only falls (ADR 0093). The counter lives
 * in plaintext under the scope's `attempts` key: it has to work while the
 * tomb is locked.
 */

import { kvSet } from "../kv.js";
import {
  BASE_LOCKOUT_MS,
  LOCK_AFTER_FAILS,
  MAX_LOCKOUT_MS,
  readJson,
} from "./store-scope.js";

export type Attempts = { fails: number; until: number };

export function readAttempts(key: string): Attempts {
  return readJson(key, { fails: 0, until: 0 });
}

/** Throws while a lockout stands; the message counts the seconds left. */
export function assertNotLockedOut(key: string): void {
  const { until } = readAttempts(key);
  if (until > Date.now()) {
    const seconds = Math.ceil((until - Date.now()) / 1000);
    throw new Error(`Too many attempts. Try again in ${seconds}s.`);
  }
}

/** One more failed unlock; from the fifth, each one backs the lockout off. */
export function recordFailedUnlock(key: string): void {
  const fails = readAttempts(key).fails + 1;
  const backoff = Math.min(
    BASE_LOCKOUT_MS * 2 ** (fails - LOCK_AFTER_FAILS),
    MAX_LOCKOUT_MS,
  );
  const until = fails >= LOCK_AFTER_FAILS ? Date.now() + backoff : 0;
  kvSet(key, JSON.stringify({ fails, until }));
}
