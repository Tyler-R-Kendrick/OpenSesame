/**
 * Recovery codes: ten one-time codes, sealed whole under the vault key,
 * standing in for any second step once each (ADR 0091).
 */

import { type SealedBlob, WrongPasswordError } from "./crypto.js";
import {
  type RecoveryCodesRecord,
  normalizeRecoveryCode,
  openRecoveryLedger,
  sealRecoveryLedger,
} from "./unlock-methods.js";

/**
 * A recovery code stands in for the second step once. Its hash is looked up
 * in the ledger sealed under the parked key, marked used, and the ledger is
 * written back before the session opens — a code spent twice is a code
 * someone copied. Returns the ledger's new wrap for the caller to persist;
 * `onMismatch` records a failed unlock attempt.
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
