/**
 * PIN wrap KDF cost scales with estimated entropy so short digit-only PINs are
 * not wrapped at a fixed iteration count an offline attacker can exhaust.
 */

import {
  type KdfParams,
  MAX_PBKDF2_ITERATIONS,
  VaultCorruptError,
  assertKdfParams,
} from "@opensesame/vault-core";

/** PIN wraps use at least the password floor; extra iterations raise offline cost. */
export const PIN_PBKDF2_ITERATIONS = 1_200_000;

/** Target offline work at the PIN PBKDF2 floor for a 50-bit secret. */
export const PIN_KDF_SECURITY_BITS = 50;

/** Conservative entropy estimate on the NFKC form (matches PIN policy). */
export function estimatePinEntropyBits(pin: string): number {
  const normalized = pin.normalize("NFKC");
  if (/^\d+$/u.test(normalized)) {
    return normalized.length * Math.log2(10);
  }
  return normalized.length * Math.log2(36);
}

export function pinPbkdf2Iterations(pin: string): number {
  const entropy = estimatePinEntropyBits(pin);
  const scale = 2 ** (PIN_KDF_SECURITY_BITS - entropy);
  const scaled = Math.ceil(PIN_PBKDF2_ITERATIONS * scale);
  return Math.min(
    MAX_PBKDF2_ITERATIONS,
    Math.max(PIN_PBKDF2_ITERATIONS, scaled),
  );
}

/**
 * Reject weakened PIN KDF metadata before derivation. Wraps enrolled before
 * scaling was introduced stay at {@link PIN_PBKDF2_ITERATIONS}.
 */
export function assertPinKdfIterations(kdf: KdfParams, pin: string): void {
  assertKdfParams(kdf);
  const required = pinPbkdf2Iterations(pin);
  if (kdf.iterations >= required) {
    return;
  }
  if (
    kdf.iterations === PIN_PBKDF2_ITERATIONS &&
    required > PIN_PBKDF2_ITERATIONS
  ) {
    return;
  }
  throw new VaultCorruptError("key derivation parameters were altered");
}
