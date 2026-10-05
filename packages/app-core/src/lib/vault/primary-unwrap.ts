/**
 * Open the raw vault key from a typed password or PIN, counting a miss as a
 * failed unlock. Kept out of `store.ts` so the store line budget only falls
 * (ADR 0093).
 *
 * A challenge this vault never enrolled must fail exactly like a wrong secret
 * (same error, same lockout count), or the screen enumerates methods.
 */

import {
  type VaultHeader,
  WrongPasswordError,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { unwrapVaultKeyWithPin } from "./unlock-methods.js";

/** What a wrong PIN says, here and when a held device refuses a right one. */
export const PIN_MISS = "That PIN did not unlock the vault.";

export async function unwrapPassword(
  header: VaultHeader,
  password: string,
  recordFailedUnlock: () => void,
): Promise<Uint8Array> {
  if (!header.wrap || !header.kdf) {
    recordFailedUnlock();
    throw new WrongPasswordError();
  }
  try {
    return await unwrapRawVaultKeyFromPassword(header, password);
  } catch (error) {
    if (error instanceof WrongPasswordError) recordFailedUnlock();
    throw error;
  }
}

export async function unwrapPin(
  header: VaultHeader,
  pin: string,
  recordFailedUnlock: () => void,
): Promise<Uint8Array> {
  const record = header.unlocks?.pin;
  if (!record) {
    recordFailedUnlock();
    throw new WrongPasswordError(PIN_MISS);
  }
  try {
    return await unwrapVaultKeyWithPin(record, pin);
  } catch (error) {
    if (!(error instanceof WrongPasswordError)) throw error;
    recordFailedUnlock();
    throw new WrongPasswordError(PIN_MISS);
  }
}
