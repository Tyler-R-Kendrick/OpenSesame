/**
 * Clone helpers for in-memory wallet interaction rows.
 */

import type {
  ExecutionReservation,
  InteractionProofAttempt,
  WalletRegistration,
} from "./wallet-interaction-types.js";

export function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** `proofInputDigest` is a Uint8Array; copy it so the store cannot be mutated. */
export function cloneProofAttempt(
  attempt: InteractionProofAttempt,
): InteractionProofAttempt {
  return { ...attempt, proofInputDigest: cloneBytes(attempt.proofInputDigest) };
}

/** `passReferenceDigest` is optional bytes; copy it when present. */
export function cloneWalletRegistration(
  registration: WalletRegistration,
): WalletRegistration {
  const copy: WalletRegistration = { ...registration };
  if (registration.passReferenceDigest !== undefined) {
    copy.passReferenceDigest = cloneBytes(registration.passReferenceDigest);
  }
  return copy;
}

/** Flat row — see cloneBindingChallenge. */
export function cloneReservation(
  reservation: ExecutionReservation,
): ExecutionReservation {
  return { ...reservation };
}

/** Key a proof-input digest for a Map, since Uint8Array is not value-comparable. */
export function digestKey(digest: Uint8Array): string {
  return Buffer.from(digest).toString("base64");
}
