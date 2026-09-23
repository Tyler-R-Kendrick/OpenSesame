/**
 * UV / PRF select options through the unlock bridge (two-input triggers).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPasskeyDuressEvidence,
  peekPasskeyDuressEvidence,
  stashPasskeyDuressEvidence,
  takePasskeyDuressEvidence,
} from "../../../screens/unlock/unlock-passkey-evidence.js";
import { onCompleteUnlockCodeSubmission } from "../../../sections/settings/security/duress-unlock-bridge.js";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import { duressSessionFence } from "../session/fence.js";
import {
  clearEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../store/unlock-enrollment.js";
import {
  createEmptyEnrollmentState,
  enrollTrigger,
} from "../trigger/enrollment.js";

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) {
    duressSessionFence.resolve(ids, true);
  }
}

describe("duress UV/PRF bridge", () => {
  beforeEach(() => {
    clearEnrollmentStateForUnlock();
    clearPasskeyDuressEvidence();
    resetFence();
  });

  it("verified_uv_then_code matches only with userVerified select options", async () => {
    let state = createEmptyEnrollmentState({
      vaultRef: "vault-uv",
      deviceBindingRef: "device-uv",
      policyRevision: 1,
      keyEpoch: 1,
      capabilities: {
        durableLocalStorage: true,
        offlineReady: true,
        prfAvailable: false,
        userVerificationAvailable: true,
      },
    });
    state = {
      ...state,
      ownerConsent: true,
    };
    state = await enrollTrigger({
      state,
      code: "55667788",
      profileId: "uv-profile",
      triggerKind: "verified_uv_then_code",
      plaintext: {
        compartmentKey: createIndependentCompartmentKey(),
        actionCapability: null,
        presentation: "decoy",
      },
      replace: true,
      autoRehearse: true,
    });
    await persistEnrollmentStateForUnlock(
      { ...state, armed: true },
      { requireDurable: false },
    );

    const withoutUv = await onCompleteUnlockCodeSubmission("55667788", {
      requireDurable: false,
    });
    expect(withoutUv.kind).toBe("normal");

    const withUv = await onCompleteUnlockCodeSubmission("55667788", {
      requireDurable: false,
      select: { userVerified: true },
    });
    expect(withUv.kind).toBe("duress");
  });

  it("passkey evidence stash is take-once and zeroed on clear", () => {
    const prf = new Uint8Array(32).fill(7);
    stashPasskeyDuressEvidence({
      userVerified: true,
      prfOutput: prf,
      origin: "https://example.test",
      credentialIdB64: "cred",
    });
    expect(peekPasskeyDuressEvidence()?.userVerified).toBe(true);
    const taken = takePasskeyDuressEvidence();
    expect(taken?.prfOutput?.[0]).toBe(7);
    expect(peekPasskeyDuressEvidence()).toBeNull();
    expect(takePasskeyDuressEvidence()).toBeNull();

    stashPasskeyDuressEvidence({
      userVerified: true,
      prfOutput: new Uint8Array(32).fill(9),
    });
    clearPasskeyDuressEvidence();
    expect(peekPasskeyDuressEvidence()).toBeNull();
  });
});
