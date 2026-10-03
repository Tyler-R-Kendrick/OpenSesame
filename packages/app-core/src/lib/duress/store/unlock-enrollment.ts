/**
 * Durable sealed EnrollmentState for pre-unlock selectTrigger (STORE + TRIGGER).
 * Ciphertext slots only — never plaintext codes.
 */

import type { EnrollmentState } from "../trigger/enrollment.js";
import {
  type JournalWriteResult,
  clearJournal,
  clearJournalDurable,
  readJournalPayload,
  recoverJournal,
  writeJournal,
} from "./journal.js";

export const ENROLLMENT_STATE_KEY = "duress.enrollment-state.v1";

type Options = Readonly<{ requireDurable?: boolean }>;
const defaultOptions = {} satisfies Options;

export async function persistEnrollmentStateForUnlock(
  state: EnrollmentState,
  options: Options = defaultOptions,
): Promise<JournalWriteResult> {
  const existing = recoverJournal<EnrollmentState>(ENROLLMENT_STATE_KEY);
  return writeJournal(ENROLLMENT_STATE_KEY, state, {
    requireDurable: options.requireDurable ?? true,
    expectedRevision: existing?.revision ?? 0,
  });
}

export function loadEnrollmentStateForUnlock(): EnrollmentState | null {
  return readJournalPayload<EnrollmentState>(ENROLLMENT_STATE_KEY);
}

export function clearEnrollmentStateForUnlock(): void {
  clearJournal(ENROLLMENT_STATE_KEY);
}

/** Remove the enrollment and wait for storage, so a reload cannot bring it back. */
export function clearEnrollmentStateDurable(): Promise<void> {
  return clearJournalDurable(ENROLLMENT_STATE_KEY);
}
