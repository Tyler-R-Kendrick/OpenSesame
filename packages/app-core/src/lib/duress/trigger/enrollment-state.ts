/**
 * Enrollment state shapes and shared normalization (TRIGGER-A).
 */

import { defined } from "@opensesame/contracts";
import {
  type PrfAndCodeEnvelope,
  type SealedSlot,
  assertTriggerCodeLength,
  openProfileSlot,
} from "../crypto/slots.js";
import { assertNotReversePinConvention, fingerprintCode } from "./codes.js";
import type { CodeTriggerKind } from "./kinds.js";

export type EnrolledTrigger = Readonly<{
  slot: SealedSlot;
  triggerKind: CodeTriggerKind;
  /** prf_and_code only: the PRF+code layer around the slot (see enrollment-seal.ts). */
  prfEnvelope?: PrfAndCodeEnvelope | undefined;
  prfEnvelopeRef?: string | undefined;
  credentialIdB64?: string | undefined;
  expectedOrigin?: string | undefined;
}>;

export type EnrollmentCapabilities = Readonly<{
  durableLocalStorage: boolean;
  prfAvailable: boolean;
  userVerificationAvailable: boolean;
  offlineReady: boolean;
}>;

export type EnrollmentState = {
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
  triggers: EnrolledTrigger[];
  ordinaryCodeFingerprints: string[];
  rehearsalPassed: boolean;
  ownerConsent: boolean;
  armed?: boolean;
  capabilities?: EnrollmentCapabilities;
};

export type EnrollmentDraft = Readonly<{
  stateSnapshot: EnrollmentState;
  pending: EnrolledTrigger | null;
  rehearsalCode: string | null;
  /** prf_and_code only: the PRF output the rehearsal opens with; zeroed on commit. */
  rehearsalPrfOutput?: Uint8Array | null;
  rehearsalPassed: boolean;
  profileId: string | null;
  replaceProfileId: string | null;
}>;

export function createEmptyEnrollmentState(base: {
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision: number;
  keyEpoch: number;
  capabilities?: Partial<EnrollmentCapabilities>;
}): EnrollmentState {
  return {
    vaultRef: base.vaultRef,
    deviceBindingRef: base.deviceBindingRef,
    policyRevision: base.policyRevision,
    keyEpoch: base.keyEpoch,
    triggers: [],
    ordinaryCodeFingerprints: [],
    rehearsalPassed: false,
    ownerConsent: false,
    armed: false,
    capabilities: {
      durableLocalStorage: base.capabilities?.durableLocalStorage ?? true,
      prfAvailable: base.capabilities?.prfAvailable ?? false,
      userVerificationAvailable:
        base.capabilities?.userVerificationAvailable ?? false,
      offlineReady: base.capabilities?.offlineReady ?? true,
    },
  };
}

export function normalizeState(state: EnrollmentState): EnrollmentState {
  return {
    ...state,
    armed: state.armed ?? false,
    capabilities: state.capabilities ?? {
      durableLocalStorage: true,
      prfAvailable: false,
      userVerificationAvailable: false,
      offlineReady: true,
    },
  };
}

export function expectFrom(state: EnrollmentState) {
  return {
    vaultRef: state.vaultRef,
    deviceBindingRef: state.deviceBindingRef,
    policyRevision: state.policyRevision,
    keyEpoch: state.keyEpoch,
  };
}

export function assertOwnerAndReadiness(state: EnrollmentState): void {
  const caps = defined(normalizeState(state).capabilities, "capabilities");
  if (!state.ownerConsent) {
    throw new Error("recovery_required: owner consent missing");
  }
  if (!caps.durableLocalStorage) {
    throw new Error("undurable_storage");
  }
  if (!caps.offlineReady) {
    throw new Error("unsupported_factor: offline readiness missing at enroll");
  }
}

export async function assertNoCollisions(input: {
  code: string;
  state: EnrollmentState;
  ordinaryCode?: string | undefined;
  ignoreProfileId?: string | undefined;
}): Promise<void> {
  assertTriggerCodeLength(input.code);
  assertNotReversePinConvention(input.code, input.ordinaryCode);

  const fp = await fingerprintCode(input.code);
  if (input.state.ordinaryCodeFingerprints.includes(fp)) {
    throw new Error("ambiguous_trigger: collides with ordinary code");
  }
  if (input.ordinaryCode) {
    assertTriggerCodeLength(input.ordinaryCode);
    const ofp = await fingerprintCode(input.ordinaryCode);
    if (ofp === fp) {
      throw new Error("ambiguous_trigger: collides with ordinary code");
    }
  }

  for (const t of input.state.triggers) {
    if (input.ignoreProfileId && t.slot.profileId === input.ignoreProfileId) {
      continue;
    }
    // A prf_and_code slot cannot be tried with a code alone — by design.
    if (t.triggerKind === "prf_and_code") continue;
    const opened = await openProfileSlot(
      input.code,
      t.slot,
      expectFrom(input.state),
    );
    if (opened) {
      opened.compartmentKey.fill(0);
      throw new Error("ambiguous_trigger: collides with enrolled slot");
    }
  }
}
