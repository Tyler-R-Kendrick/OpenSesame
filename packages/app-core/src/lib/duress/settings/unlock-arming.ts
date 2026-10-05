/**
 * SETTINGS → TRIGGER arming: seal application-code slots and persist for unlock.
 * Digest-only CodeSlotStatus stays for UI; sealed EnrollmentState drives selectTrigger.
 */

import type { PresentationClass } from "../access/context.js";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import type { JournalWriteResult } from "../store/journal.js";
import { codeOpensDeviceVault } from "../store/ordinary-unlock-probe.js";
import {
  clearEnrollmentStateDurable,
  persistEnrollmentStateForUnlock,
} from "../store/unlock-enrollment.js";
import {
  type EnrollmentCapabilities,
  type EnrollmentState,
  createEmptyEnrollmentState,
  enrollTrigger,
} from "../trigger/enrollment.js";

export type SealUnlockTriggerInput = Readonly<{
  code: string;
  profileId: string;
  vaultRef: string;
  deviceBindingRef: string;
  policyRevision?: number;
  keyEpoch?: number;
  presentation: PresentationClass | string;
  /** The mode's sealed plan (`modes/payload.ts`), read back at unlock. */
  payload?: Uint8Array;
  previous?: EnrollmentState | null;
  /**
   * Explicit owner consent. When omitted, a previous state's recorded consent
   * is kept; a fresh enrollment stays unconsented and is refused downstream.
   */
  ownerConsent?: boolean;
  /**
   * Measured device capabilities, used only for a fresh enrollment. Omitted
   * entries fail closed through assertOwnerAndReadiness.
   */
  capabilities?: Partial<EnrollmentCapabilities>;
  /**
   * Whether `code` is also an ordinary unlock secret. Defaults to trying every
   * vault's PIN and password wraps on this device; tests may stand in.
   */
  opensOrdinaryUnlock?: (code: string) => Promise<boolean>;
}>;

function asPresentation(value: string): PresentationClass {
  if (
    value === "normal" ||
    value === "restricted" ||
    value === "decoy" ||
    value === "locked" ||
    value === "unchanged"
  ) {
    return value;
  }
  return "restricted";
}

function measuredCapabilities(
  input: SealUnlockTriggerInput,
): EnrollmentCapabilities {
  return {
    durableLocalStorage: input.capabilities?.durableLocalStorage ?? false,
    prfAvailable: input.capabilities?.prfAvailable ?? false,
    userVerificationAvailable:
      input.capabilities?.userVerificationAvailable ?? false,
    offlineReady: input.capabilities?.offlineReady ?? false,
  };
}

function baseEnrollmentState(input: SealUnlockTriggerInput): EnrollmentState {
  return (
    input.previous ??
    createEmptyEnrollmentState({
      vaultRef: input.vaultRef,
      deviceBindingRef: input.deviceBindingRef,
      policyRevision: input.policyRevision ?? 1,
      keyEpoch: input.keyEpoch ?? 1,
      capabilities: measuredCapabilities(input),
    })
  );
}

/**
 * Seal a fresh application_code trigger (auto-rehearse). Does not mark armed
 * until {@link armPersistedUnlockEnrollment}.
 */
export async function sealUnlockTriggerFromCeremony(
  input: SealUnlockTriggerInput,
): Promise<EnrollmentState> {
  // The trigger is checked before any unwrap: one equal to a vault's own PIN
  // or password would open the decoy in place of that vault, every time.
  const opensOrdinary = input.opensOrdinaryUnlock ?? codeOpensDeviceVault;
  if (await opensOrdinary(input.code)) {
    throw new Error("ambiguous_trigger: collides with ordinary code");
  }
  const base = baseEnrollmentState(input);

  const consented: EnrollmentState = {
    ...base,
    ownerConsent: input.ownerConsent ?? base.ownerConsent,
    vaultRef: input.vaultRef,
    deviceBindingRef: input.deviceBindingRef,
    policyRevision: input.policyRevision ?? base.policyRevision,
    keyEpoch: input.keyEpoch ?? base.keyEpoch,
  };

  const enrolled = await enrollTrigger({
    state: consented,
    code: input.code,
    profileId: input.profileId,
    triggerKind: "application_code",
    plaintext: {
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: asPresentation(String(input.presentation)),
      ...(input.payload ? { payload: input.payload } : {}),
    },
    replace: true,
    autoRehearse: true,
  });

  return { ...enrolled, armed: false };
}

type Options = Readonly<{ requireDurable?: boolean }>;
const defaultOptions = {} satisfies Options;

export async function armPersistedUnlockEnrollment(
  state: EnrollmentState,
  options: Options = defaultOptions,
): Promise<JournalWriteResult> {
  if (!state.triggers.length) {
    return {
      ok: false,
      code: "interrupted_write",
      message: "No sealed triggers to arm.",
    };
  }
  return persistEnrollmentStateForUnlock(
    { ...state, armed: true },
    { requireDurable: options.requireDurable ?? true },
  );
}

/** Disarm, waiting for storage: a code that comes back on reload was not removed. */
export async function disarmPersistedUnlockEnrollment(): Promise<void> {
  await clearEnrollmentStateDurable();
}
