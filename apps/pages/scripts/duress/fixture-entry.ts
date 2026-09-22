import { AlertOutbox } from "../../src/lib/duress/alert/outbox.ts";
import {
  createAlertSealingKey,
  sealAlertPackage,
} from "../../src/lib/duress/alert/seal.ts";
/**
 * Window-facing fixture API for Playwright journeys.
 * Leaf imports only — avoids broken barrel / contracts↔os-domain gaps.
 */
import {
  DURESS_PIN_PBKDF2_ITERATIONS,
  assertTriggerCodeLength,
  createIndependentCompartmentKey,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealProfileSlot,
} from "../../src/lib/duress/crypto/slots.ts";
import {
  type DuressFormatHeader,
  refuseUnsupportedDuressFormat,
} from "../../src/lib/duress/feature/format.ts";
import {
  generatePeerKeyPair,
  signPeerEnvelope,
  verifyPeerEnvelope,
} from "../../src/lib/duress/peer/envelope.ts";
import { DuressSessionFence } from "../../src/lib/duress/session/fence.ts";
import {
  createEmptyEnrollmentState,
  enrollTrigger,
  selectTrigger,
} from "../../src/lib/duress/trigger/enrollment.ts";

declare global {
  interface Window {
    __duressQa: typeof api;
  }
}

/** Mirrors settings/arming.canArmProfile without pulling contracts. */
function canArmProfile(checklist: {
  ownerConsent: boolean;
  destructiveAck: boolean;
  rehearsalPassed: boolean;
  durableStorage: boolean;
  enrolledTriggers: boolean;
  exposureReviewed: boolean;
}): boolean {
  return (
    checklist.ownerConsent &&
    checklist.destructiveAck &&
    checklist.rehearsalPassed &&
    checklist.durableStorage &&
    checklist.enrolledTriggers &&
    checklist.exposureReviewed
  );
}

function resolveDuressMode(
  env: Record<string, string | undefined> = {},
): "off" | "local_only" | "optional_peer" {
  const raw = (env.VITE_DURESS_MODE ?? env.DURESS_MODE ?? "off")
    .trim()
    .toLowerCase();
  if (raw === "local_only" || raw === "optional_peer") return raw;
  return "off";
}

const api = {
  version: 1,
  DURESS_PIN_PBKDF2_ITERATIONS,
  assertTriggerCodeLength,
  createIndependentCompartmentKey,
  sealProfileSlot,
  openProfileSlot,
  sealPrfAndCode,
  openPrfAndCode,
  createEmptyEnrollmentState,
  enrollTrigger,
  selectTrigger,
  generatePeerKeyPair,
  signPeerEnvelope,
  verifyPeerEnvelope,
  createAlertSealingKey,
  sealAlertPackage,
  AlertOutbox,
  DuressSessionFence,
  canArmProfile,
  refuseUnsupportedDuressFormat: (
    header: DuressFormatHeader | null | undefined,
    readerSupportsVersion: number,
  ) => refuseUnsupportedDuressFormat(header, readerSupportsVersion),
  resolveDuressMode,
  /** Simulated PRF bytes only — never claims hardware PRF. */
  fakePrfOutput(bytes = 32): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(bytes));
  },
  async webcryptoProbe() {
    const subtle = globalThis.crypto?.subtle;
    return {
      crypto: typeof globalThis.crypto !== "undefined",
      subtle: Boolean(subtle),
      pbkdf2: Boolean(subtle?.deriveBits),
      aesGcm: Boolean(subtle?.encrypt),
      hkdf: Boolean(subtle?.deriveBits),
      ecdsa: Boolean(subtle?.sign),
      digest: Boolean(subtle?.digest),
      getRandomValues: typeof globalThis.crypto?.getRandomValues === "function",
    };
  },
};

window.__duressQa = api;
export default api;
