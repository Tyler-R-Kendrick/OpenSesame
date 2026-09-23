/**
 * SETTINGS → TRIGGER arming: seal application-code slots and persist for unlock.
 * Digest-only CodeSlotStatus stays for UI; sealed EnrollmentState drives selectTrigger.
 */

import type { PresentationClass } from "../access/context.js";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import type { JournalWriteResult } from "../store/journal.js";
import { codeOpensDeviceVault } from "../store/ordinary-unlock-probe.js";
import {
  clearEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../store/unlock-enrollment.js";
import {
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
  previous?: EnrollmentState | null;
  ownerConsent?: boolean;
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
  const previous = input.previous ?? null;
  const base =
    previous ??
    createEmptyEnrollmentState({
      vaultRef: input.vaultRef,
      deviceBindingRef: input.deviceBindingRef,
      policyRevision: input.policyRevision ?? 1,
      keyEpoch: input.keyEpoch ?? 1,
      capabilities: {
        durableLocalStorage: true,
        offlineReady: true,
        prfAvailable: false,
        userVerificationAvailable: false,
      },
    });

  const consented: EnrollmentState = {
    ...base,
    ownerConsent: input.ownerConsent !== false,
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

export async function disarmPersistedUnlockEnrollment(): Promise<void> {
  clearEnrollmentStateForUnlock();
}
