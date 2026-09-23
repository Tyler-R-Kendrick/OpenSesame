/**
 * prf_and_code is two inputs in fact, not in name (TRIGGER-C, KEYS-E): the
 * enrolled passkey's PRF output and the complete code, bound to that passkey
 * and origin. Random bytes of the right length open nothing.
 */

import { defined } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import { createIndependentCompartmentKey } from "../crypto/slots.js";
import {
  type EnrollmentState,
  createEmptyEnrollmentState,
  disposeTriggerMatch,
  enrollTrigger,
  selectTrigger,
} from "./enrollment.js";
import { openVerifiedUvThenCode } from "./kinds.js";

function baseState(): EnrollmentState {
  return {
    ...createEmptyEnrollmentState({
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
      capabilities: {
        durableLocalStorage: true,
        prfAvailable: true,
        userVerificationAvailable: true,
        offlineReady: true,
      },
    }),
    ownerConsent: true,
  };
}

function plain() {
  return {
    compartmentKey: createIndependentCompartmentKey(),
    actionCapability: null,
    presentation: "decoy",
  };
}

describe("TRIGGER-C prf_and_code", () => {
  it("prf_and_code requires the enrolled passkey's PRF output before key release", async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const binding = {
      origin: "https://example.test",
      credentialIdB64: "cred-1",
    };
    const state = await enrollTrigger({
      state: baseState(),
      code: "99990000",
      profileId: "prf",
      triggerKind: "prf_and_code",
      plaintext: plain(),
      credentialIdB64: "cred-1",
      expectedOrigin: "https://example.test",
      prfOutput: prf,
    });
    const status = async (options: Parameters<typeof selectTrigger>[2]) =>
      (await selectTrigger("99990000", state, options)).status;
    expect(await status({ ...binding, prfOutput: null })).toBe("none");
    expect(await status({ ...binding, prfOutput: new Uint8Array(16) })).toBe(
      "none",
    );
    // Any 32 bytes are not the passkey: the PRF is a key, not a length check.
    expect(
      await status({
        ...binding,
        prfOutput: crypto.getRandomValues(new Uint8Array(32)),
      }),
    ).toBe("none");
    // The right PRF with the wrong code, or without the passkey's binding.
    expect(
      (await selectTrigger("99990001", state, { ...binding, prfOutput: prf }))
        .status,
    ).toBe("none");
    expect(await status({ prfOutput: prf })).toBe("none");
    expect(
      await status({ ...binding, credentialIdB64: "cred-2", prfOutput: prf }),
    ).toBe("none");
    const hit = await selectTrigger("99990000", state, {
      ...binding,
      prfOutput: prf,
    });
    expect(hit.status).toBe("matched");
    if (hit.status === "matched") disposeTriggerMatch(hit);
  });

  it("prf_and_code keeps nothing a code alone can open", async () => {
    const state = await enrollTrigger({
      state: baseState(),
      code: "99990000",
      profileId: "prf",
      triggerKind: "prf_and_code",
      plaintext: plain(),
      credentialIdB64: "cred-1",
      expectedOrigin: "https://example.test",
      prfOutput: crypto.getRandomValues(new Uint8Array(32)),
    });
    const t = defined(state.triggers[0], "trigger");
    expect(t.slot.ciphertextB64).toBe("");
    expect(t.prfEnvelope).toBeDefined();
    expect(
      await openVerifiedUvThenCode({
        userVerified: true,
        code: "99990000",
        slot: t.slot,
        expect: {
          vaultRef: state.vaultRef,
          deviceBindingRef: state.deviceBindingRef,
          policyRevision: state.policyRevision,
          keyEpoch: state.keyEpoch,
        },
      }),
    ).toBeNull();
  });

  it("prf_and_code refuses to enroll without the PRF output", async () => {
    await expect(
      enrollTrigger({
        state: baseState(),
        code: "99990000",
        profileId: "prf",
        triggerKind: "prf_and_code",
        plaintext: plain(),
        credentialIdB64: "cred-1",
        expectedOrigin: "https://example.test",
      }),
    ).rejects.toThrow(/unsupported_factor/);
  });
});
