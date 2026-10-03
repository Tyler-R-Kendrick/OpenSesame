/**
 * Passkey unlock ceremony + held-PRF activate — kept out of vault/store.ts
 * so the store line budget only falls (ADR 0093).
 */

import {
  type PasskeyUnlockRecord,
  type VaultHeader,
  WrongPasswordError,
  importVaultKey,
} from "@opensesame/vault-core";
import { protectorToUnlockRecord } from "./protection/adapters/webauthn-prf-ops.js";
import { capsuleRecordsFor } from "./protection/unlock-protector-methods.js";
import {
  type PasskeyCeremony,
  getPasskeyUnlockCeremony,
  getPasskeyUnlockCeremonyFor,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";

export type PasskeyUnlockSessionHost = Readonly<{
  header: () => VaultHeader | null;
  assertNotLockedOut: () => void;
  recordFailedUnlock: () => void;
  stashRaw: (raw: Uint8Array) => void;
  afterPrimaryUnwrap: (vaultKey: CryptoKey) => Promise<void>;
}>;

/** Wrap the raw vault key under the PRF output a create ceremony returned. */
export function wrapVaultKeyWithCeremony(
  raw: Uint8Array,
  ceremony: PasskeyCeremony,
): Promise<PasskeyUnlockRecord> {
  return wrapVaultKeyWithPrf(
    raw,
    ceremony.prfOutput,
    ceremony.prfSalt,
    ceremony.credential.rawId,
    ceremony.userId,
  );
}

/**
 * The passkey wraps this vault opens with: the header's own, then any passkey
 * capsule the manifest enrolled beside it (ADR 0152). A capsule has no wrap in
 * `unlocks`, so without this it could be tested but never used to unlock.
 */
export function passkeyUnlockRecords(
  header: VaultHeader,
): PasskeyUnlockRecord[] {
  const own = header.unlocks?.passkey;
  const records: PasskeyUnlockRecord[] = own ? [own] : [];
  for (const record of capsuleRecordsFor(header, "passkey")) {
    if (record.kind !== "webauthn-prf") continue;
    const wrap = protectorToUnlockRecord(record);
    if (!records.some((row) => row.credentialIdB64 === wrap.credentialIdB64)) {
      records.push(wrap);
    }
  }
  return records;
}

export async function probePasskeyPrf(
  host: PasskeyUnlockSessionHost,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  const records = passkeyUnlockRecords(header);
  const [record] = records;
  if (!record) {
    host.recordFailedUnlock();
    throw new WrongPasswordError("That passkey did not unlock the vault.");
  }
  try {
    if (records.length === 1) {
      return await getPasskeyUnlockCeremony(record, undefined, signal);
    }
    const options = signal ? { signal } : {};
    return (await getPasskeyUnlockCeremonyFor(records, options)).prfOutput;
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
  let raw: Uint8Array | null = null;
  for (const record of passkeyUnlockRecords(header)) {
    try {
      raw = await unwrapVaultKeyWithPrf(record, prfOutput);
      break;
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error;
    }
  }
  if (!raw) {
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
