/**
 * Recovery codes: ten one-time codes, sealed whole under the vault key,
 * standing in for any second step once each (ADR 0091).
 */

import { type SealedBlob, WrongPasswordError } from "@opensesame/vault-core";
import {
  RECOVERY_CODE_COUNT,
  type RecoveryCodesRecord,
  type RecoveryLedger,
  normalizeRecoveryCode,
  openRecoveryLedger,
  randomRecoveryCodes,
  sealRecoveryLedger,
} from "./unlock-methods.js";

/** The address a code channel sends to, masked for display. */
export function maskCodeAddress(channel: "email" | "sms", to: string): string {
  if (channel === "email") {
    const at = to.indexOf("@");
    return `${to.slice(0, 1)}•••${to.slice(at)}`;
  }
  return `${to.slice(0, Math.max(2, to.length - 10))} ••• ••• ${to.slice(-4)}`;
}

export type MintedRecoveryCodes = {
  codes: string[];
  record: RecoveryCodesRecord;
};

export type ReadRecoveryCodes = {
  codes: string[];
  used: boolean[];
  since: string;
};

/** A fresh set of codes and the `unlocks.recovery` record that seals them. */
export async function mintRecoveryCodes(
  vaultKey: CryptoKey,
): Promise<MintedRecoveryCodes> {
  const codes = randomRecoveryCodes(RECOVERY_CODE_COUNT);
  const ledger: RecoveryLedger = { codes, used: codes.map(() => false) };
  const codesWrap = await sealRecoveryLedger(vaultKey, ledger);
  const since = new Date().toISOString();
  return { codes, record: { codesWrap, total: codes.length, since } };
}

/** The codes and which are spent, from the record sealed under the vault key. */
export async function readRecoveryCodes(
  vaultKey: CryptoKey,
  record: RecoveryCodesRecord,
): Promise<ReadRecoveryCodes> {
  const ledger = await openRecoveryLedger(vaultKey, record);
  return { codes: ledger.codes, used: ledger.used, since: record.since };
}

/**
 * A recovery code stands in for the second step once. The typed code is
 * matched against the unspent codes in the ledger (sealed whole under the
 * vault key), the match is marked used, and the ledger is re-sealed before
 * the session opens — a code spent twice is a code someone copied. Returns
 * the ledger's new wrap for the caller to persist; `onMismatch` records a
 * failed unlock attempt.
 */
export async function spendRecoveryCode(
  vaultKey: CryptoKey,
  record: RecoveryCodesRecord,
  code: string,
  onMismatch: () => void,
): Promise<SealedBlob> {
  const ledger = await openRecoveryLedger(vaultKey, record);
  const typed = normalizeRecoveryCode(code);
  const index = ledger.codes.findIndex(
    (candidate, i) =>
      typed.length > 0 &&
      normalizeRecoveryCode(candidate) === typed &&
      !ledger.used[i],
  );
  if (index < 0) {
    onMismatch();
    throw new WrongPasswordError("That recovery code is not valid.");
  }
  const used = ledger.used.map((flag, i) => flag || i === index);
  return sealRecoveryLedger(vaultKey, { codes: ledger.codes, used });
}
