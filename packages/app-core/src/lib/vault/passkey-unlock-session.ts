/**
 * Passkey unlock ceremony + held-PRF activate — kept out of vault/store.ts
 * so the store line budget only falls (ADR 0093).
 */

import {
  type PasskeyUnlockRecord,
  type VaultHeader,
  WrongPasswordError,
  importVaultKey,
  mintVaultKey,
} from "@opensesame/vault-core";
import type { PasskeyCreateOptions } from "./protection/adapters/webauthn-prf-ceremony.js";
import { protectorToUnlockRecord } from "./protection/adapters/webauthn-prf-ops.js";
import { capsuleRecordsFor } from "./protection/unlock-protector-methods.js";
import {
  type PasskeyCeremony,
  createPasskeyUnlockCeremony,
  getPasskeyUnlockCeremony,
  getPasskeyUnlockCeremonyFor,
  unwrapVaultKeyWithPrf,
  wrapVaultKeyWithPrf,
} from "./unlock-methods.js";

/** What a wrong passkey says, and what a held device repeats for a right one. */
const PASSKEY_MISS = "That passkey did not unlock the vault.";

export type PasskeyUnlockSessionHost = Readonly<{
  header: () => VaultHeader | null;
  assertNotLockedOut: () => void;
  recordFailedUnlock: () => void;
  stashRaw: (raw: Uint8Array) => void;
  /** `miss` is the text this method gives a wrong secret, for a held device to repeat. */
  afterPrimaryUnwrap: (vaultKey: CryptoKey, miss?: string) => Promise<void>;
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
 * First-run seal under a passkey PRF wrap — no master password required. A
 * refused or cancelled ceremony persists nothing and zeroes the minted key.
 */
export async function sealNewVaultWithPasskey(
  persist: (
    header: VaultHeader,
    vaultKey: CryptoKey,
    rawVaultKey: Uint8Array,
  ) => Promise<void>,
  signal?: AbortSignal,
  options?: PasskeyCreateOptions,
): Promise<void> {
  const aborted = () =>
    new DOMException("The operation was aborted.", "AbortError");
  if (signal?.aborted) throw aborted();
  const { vaultKey, rawVaultKey } = await mintVaultKey();
  try {
    const ceremony = await createPasskeyUnlockCeremony(
      undefined,
      signal,
      options,
    );
    if (signal?.aborted) throw aborted();
    const record = await wrapVaultKeyWithCeremony(rawVaultKey, ceremony);
    const header: VaultHeader = {
      v: 1,
      createdAt: new Date().toISOString(),
      unlocks: { passkey: record },
    };
    await persist(header, vaultKey, rawVaultKey);
  } catch (error) {
    rawVaultKey.fill(0);
    throw error;
  }
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

export type PasskeyProbe = Readonly<{
  prfOutput: ArrayBuffer;
  /** The credential that actually answered, not the one the header names first. */
  credentialIdB64: string;
}>;

export type PasskeyProbeOptions = Readonly<{
  signal?: AbortSignal | undefined;
  /**
   * Offer only these credentials. A duress trigger bound to one passkey asks
   * for exactly that one: another credential's PRF output cannot carry it.
   */
  onlyCredentialIds?: readonly string[] | undefined;
}>;

export async function probePasskeyCeremony(
  host: PasskeyUnlockSessionHost,
  options: PasskeyProbeOptions = {},
): Promise<PasskeyProbe> {
  host.assertNotLockedOut();
  const header = host.header();
  if (!header) throw new Error("There is no vault on this device yet.");
  const { signal, onlyCredentialIds } = options;
  const all = passkeyUnlockRecords(header);
  const records = onlyCredentialIds
    ? all.filter((row) => onlyCredentialIds.includes(row.credentialIdB64))
    : all;
  const [record] = records;
  if (!record) {
    // A restriction that left nothing to offer guessed nothing, so it does not
    // count against the lockout; a vault with no passkey at all does.
    if (all.length === 0) host.recordFailedUnlock();
    throw new WrongPasswordError(PASSKEY_MISS);
  }
  try {
    if (records.length === 1) {
      return {
        prfOutput: await getPasskeyUnlockCeremony(record, undefined, signal),
        credentialIdB64: record.credentialIdB64,
      };
    }
    const ceremony = await getPasskeyUnlockCeremonyFor(
      records,
      signal ? { signal } : {},
    );
    return {
      prfOutput: ceremony.prfOutput,
      credentialIdB64: ceremony.credentialIdB64,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    throw error instanceof Error ? error : new Error("Passkey unlock failed.");
  }
}

export async function probePasskeyPrf(
  host: PasskeyUnlockSessionHost,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const probe = await probePasskeyCeremony(host, signal ? { signal } : {});
  return probe.prfOutput;
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
    throw new WrongPasswordError(PASSKEY_MISS);
  }
  host.stashRaw(raw);
  const vaultKey = await importVaultKey(raw);
  await host.afterPrimaryUnwrap(vaultKey, PASSKEY_MISS);
}

export async function unlockVaultWithPasskey(
  host: PasskeyUnlockSessionHost,
  signal?: AbortSignal,
): Promise<void> {
  const prfOutput = await probePasskeyPrf(host, signal);
  await unlockVaultWithHeldPrf(host, prfOutput);
}
