/**
 * Authenticated profile-slot crypto and PRF-and-code composition (KEYS-B/C/E).
 * Real WebCrypto AES-GCM + PBKDF2. Domain-separated from vault password wraps.
 * Activation packages open without a protected shared-root bootstrap.
 */

export {
  DURESS_PIN_MAX,
  DURESS_PIN_MIN,
  DURESS_PIN_PBKDF2_ITERATIONS,
} from "../keys/pin-floors.js";

export { assertTriggerCodeLength } from "./slot-bytes.js";
export {
  MAX_SLOTS,
  createIndependentCompartmentKey,
  openProfileSlot,
  sealProfileSlot,
  type SealedSlot,
  type SlotPlaintext,
} from "./slot-profile.js";
export {
  openPrfAndCode,
  sealPrfAndCode,
  sealPrfAndCodeWithDisclosure,
  type PrfAndCodeEnvelope,
  type PrfAndCodeSealResult,
} from "./slot-prf.js";
