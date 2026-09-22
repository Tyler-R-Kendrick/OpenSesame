/**
 * Duress KDF floors — re-exports KEYS pin-floors (authority: unlock-methods).
 */
export {
  DURESS_PIN_MAX,
  DURESS_PIN_MIN,
  DURESS_PIN_PBKDF2_ITERATIONS,
  DURESS_PIN_PBKDF2_ITERATIONS_MAX,
  DuressKdfError,
  assertDuressCodeLength,
  assertDuressKdfIterations,
  assertDuressKdfParams,
  isDuressKdfError,
} from "../keys/pin-floors.js";

import { VaultCorruptError } from "../../vault/crypto.js";
import type { BoundaryValue } from "../json-boundary.js";
import { DuressKdfError } from "../keys/pin-floors.js";

/** Map vault corrupt errors into duress KDF failures without leaking detail. */
export function rethrowAsDuressKdf(error: BoundaryValue): never {
  if (error instanceof DuressKdfError) throw error;
  if (error instanceof VaultCorruptError) {
    throw new DuressKdfError("key derivation parameters were altered");
  }
  throw error;
}
