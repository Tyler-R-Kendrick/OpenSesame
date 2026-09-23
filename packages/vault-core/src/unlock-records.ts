/**
 * The unlock records a vault header carries (vault-format-v1 §4): alternate
 * wraps of the vault key (passkey PRF, PIN) and the sealed second steps
 * (authenticator seed, email or text channel, recovery codes). Types only;
 * the ceremonies that write and open them are `unlock-methods.ts`.
 */
import type { KdfParams, SealedBlob } from "./crypto.js";

export type PasskeyUnlockRecord = {
  credentialIdB64: string;
  userIdB64: string;
  /** Public salt fed to the PRF eval + HKDF. */
  prfSaltB64: string;
  wrap: SealedBlob;
};

export type PinUnlockRecord = {
  kdf: KdfParams;
  wrap: SealedBlob;
};

export type TotpGateRecord = {
  /** AES-GCM(VK) over the TOTP secret (UTF-8 / base32 seed). */
  secretWrap: SealedBlob;
  digits: 6;
  period: 30;
  /** The vault's own authenticator entry, when registered (ADR 0113). An item ID is plaintext, not a secret. */
  selfItemId?: string;
};

/** Where a one-time code goes. The address itself is sealed, not the fact. */
export type CodeChannel = "email" | "sms";

/**
 * A code sent by the Identity API — the fallback second step. The header
 * says only that the channel is enrolled; the address is AES-GCM(VK).
 */
export type RemoteCodeRecord = {
  /** AES-GCM(VK) over the address or E.164 number. */
  toWrap: SealedBlob;
  /** ISO date the channel was confirmed with its first code. */
  since: string;
};

/**
 * Ten one-time codes that stand in for the second step once each. Sealed
 * under the vault key, the same envelope as the authenticator seed: a header
 * on disk discloses that codes exist, never what they are.
 */
export type RecoveryCodesRecord = {
  /** AES-GCM(VK) over JSON `{ codes: string[], used: boolean[] }`. */
  codesWrap: SealedBlob;
  total: number;
  since: string;
};

export type VaultUnlocks = {
  /** Legacy single passkey wrap — still written for older readers. */
  passkey?: PasskeyUnlockRecord | undefined;
  /** Multi-credential PRF wraps; on read, a lone `passkey` becomes one entry. */
  passkeys?: PasskeyUnlockRecord[];
  pin?: PinUnlockRecord;
  totp?: TotpGateRecord;
  email?: RemoteCodeRecord;
  sms?: RemoteCodeRecord;
  recovery?: RecoveryCodesRecord;
};
