/**
 * PIN / application-code floors for duress slots (KEYS-D / INV-06).
 * Authority: vault unlock-methods — never cheaper than ordinary PIN unwrap.
 */

import {
  MAX_PBKDF2_ITERATIONS,
  SALT_BYTES,
  b64ToBytes,
} from "@opensesame/vault-core";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  PIN_PBKDF2_ITERATIONS,
} from "../../vault/unlock-methods.js";
import type { BoundaryValue } from "../json-boundary.js";

export const DURESS_PIN_MIN = MIN_PIN_LENGTH;
export const DURESS_PIN_MAX = MAX_PIN_LENGTH;
export const DURESS_PIN_PBKDF2_ITERATIONS = PIN_PBKDF2_ITERATIONS;
/** Same ceiling as vault `MAX_PBKDF2_ITERATIONS` — reject unbound metadata. */
export const DURESS_PIN_PBKDF2_ITERATIONS_MAX = MAX_PBKDF2_ITERATIONS;

export class DuressKdfError extends Error {
  readonly code = "unsupported_factor" as const;
  constructor(detail: string) {
    super(`unsupported_factor: ${detail}`);
    this.name = "DuressKdfError";
  }
}

export function assertDuressCodeLength(code: string): void {
  if (code.length < DURESS_PIN_MIN || code.length > DURESS_PIN_MAX) {
    throw new DuressKdfError("code length");
  }
  if (!/^[0-9]+$/.test(code)) {
    throw new DuressKdfError("code charset");
  }
}

export function assertDuressKdfIterations(iterations: number): void {
  if (!Number.isInteger(iterations)) {
    throw new DuressKdfError("KDF iterations must be an integer");
  }
  if (iterations < DURESS_PIN_PBKDF2_ITERATIONS) {
    throw new DuressKdfError("KDF iterations below PIN floor");
  }
  if (iterations > DURESS_PIN_PBKDF2_ITERATIONS_MAX) {
    throw new DuressKdfError("KDF iterations unbounded");
  }
}

/**
 * Bound evaluation: reject malicious salt/iteration metadata before deriveBits.
 * No cheap plaintext verifier — AES-GCM auth is the only membership check.
 */
export function assertDuressKdfParams(input: {
  iterations: number;
  saltB64: string;
}): void {
  assertDuressKdfIterations(input.iterations);
  let salt: Uint8Array;
  try {
    salt = b64ToBytes(input.saltB64);
  } catch {
    throw new DuressKdfError("KDF salt is not valid base64");
  }
  if (salt.length !== SALT_BYTES) {
    throw new DuressKdfError("KDF salt is the wrong size");
  }
}

export function isDuressKdfError(
  error: BoundaryValue,
): error is DuressKdfError {
  return error instanceof DuressKdfError;
}
