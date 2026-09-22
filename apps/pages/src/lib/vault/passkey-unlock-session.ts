/**
 * Passkey unlock ceremony + held-PRF activate — kept out of vault/store.ts
 * so the store line budget only falls (ADR 0093).
 */

import {
  WrongPasswordError,
  type VaultHeader,
  importVaultKey,
} from "./crypto.js";
import {
  getPasskeyUnlockCeremony,
  unwrapVaultKeyWithPrf,
} from "./unlock-methods.js";

export type PasskeyUnlockSessionHost = Readonly<{
  header: () => VaultHeader | null;
  assertNotLockedOut: () => void;
  recordFailedUnlock: () => void;
  stashRaw: (raw: Uint8Array) => void;
  afterPrimaryUnwrap: (vaultKey: CryptoKey) => Promise<void>;
}>;

export async function probePasskeyPrf(
  host: PasskeyUnlockSessionHost,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  const record = header.unlocks?.passkey;
  if (!record) {
    host.recordFailedUnlock();
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }
  try {
    return await getPasskeyUnlockCeremony(record, undefined, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw error instanceof Error ? error : new Error("Passkey unlock failed.");
  }
}

export async function unlockVaultWithHeldPrf(
  host: PasskeyUnlockSessionHost,
  prfOutput: ArrayBuffer,
): Promise<void> {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  const record = header.unlocks?.passkey;
  if (!record) {
    host.recordFailedUnlock();
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }
  let raw: Uint8Array;
  try {
    raw = await unwrapVaultKeyWithPrf(record, prfOutput);
  } catch (error) {
    if (!(error instanceof WrongPasswordError)) throw error;
    host.recordFailedUnlock();
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }
  host.stashRaw(raw);
  const vaultKey = await importVaultKey(raw);
  await host.afterPrimaryUnwrap(vaultKey);
}

export async function unlockVaultWithPasskey(
  host: PasskeyUnlockSessionHost,
  signal?: AbortSignal,
): Promise<void> {
  const prfOutput = await probePasskeyPrf(host, signal);
  await unlockVaultWithHeldPrf(host, prfOutput);
}
