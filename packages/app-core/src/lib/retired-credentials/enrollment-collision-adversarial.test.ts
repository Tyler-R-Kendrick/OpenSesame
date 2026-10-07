import { afterEach, beforeEach, expect, it } from "vitest";
import { createIndependentCompartmentKey } from "../duress/crypto/slots.js";
import { sealUnlockTriggerFromCeremony } from "../duress/settings/unlock-arming.js";
import {
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../duress/store/unlock-enrollment.js";
import { fingerprintCode } from "../duress/trigger/codes.js";
import {
  createEmptyEnrollmentState,
  enrollTrigger,
} from "../duress/trigger/enrollment.js";
import { retiredCredentialStatus } from "./index.js";
import { createRetiredCredentialFixture } from "./test-support.js";

let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => {
  clearEnrollmentStateForUnlock();
  fixture.restore();
});

async function sealedState() {
  return sealUnlockTriggerFromCeremony({
    code: "24681357",
    profileId: "existing-duress",
    vaultRef: "personal",
    deviceBindingRef: "controlled-device",
    presentation: "decoy",
    ownerConsent: true,
    capabilities: { durableLocalStorage: true, offlineReady: true },
  });
}

it("rejects a retired-password trap that would collide with an existing sealed duress trigger", async () => {
  const state = await sealedState();
  await persistEnrollmentStateForUnlock(state, { requireDurable: false });
  const owner = fixture.store.getSnapshot();
  await expect(fixture.enroll("24681357")).rejects.toThrow(/collides/);
  expect(retiredCredentialStatus("personal").traps).toHaveLength(0);
  expect(loadEnrollmentStateForUnlock()).toEqual(state);
  expect(fixture.store.getSnapshot()).toEqual(owner);
});

it("rejects an existing ordinary unlock fingerprint even when no duress slot opens", async () => {
  const state = {
    ...(await sealedState()),
    ordinaryCodeFingerprints: [await fingerprintCode("selected old password")],
  };
  await persistEnrollmentStateForUnlock(state, { requireDurable: false });
  const owner = fixture.store.getSnapshot();
  await expect(fixture.enroll("selected old password")).rejects.toThrow(
    /collides/,
  );
  expect(retiredCredentialStatus("personal").traps).toHaveLength(0);
  expect(loadEnrollmentStateForUnlock()).toEqual(state);
  expect(fixture.store.getSnapshot()).toEqual(owner);
});

it("permits an unrelated trap beside an existing duress trigger without changing that policy", async () => {
  const state = await sealedState();
  await persistEnrollmentStateForUnlock(state, { requireDurable: false });
  await fixture.enroll("unrelated selected old password");
  expect(retiredCredentialStatus("personal").traps).toHaveLength(1);
  expect(loadEnrollmentStateForUnlock()).toEqual(state);
});

it("refuses trap enrollment when an existing two-secret duress trigger makes collision proof unavailable", async () => {
  const state = await enrollTrigger({
    state: {
      ...createEmptyEnrollmentState({
        vaultRef: "personal",
        deviceBindingRef: "controlled-device",
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
    },
    code: "35792468",
    profileId: "existing-two-secret",
    triggerKind: "prf_and_code",
    plaintext: {
      compartmentKey: createIndependentCompartmentKey(),
      actionCapability: null,
      presentation: "decoy",
    },
    credentialIdB64: "controlled-credential",
    expectedOrigin: "https://controlled.example.invalid",
    prfOutput: crypto.getRandomValues(new Uint8Array(32)),
  });
  await persistEnrollmentStateForUnlock(state, { requireDurable: false });
  await expect(fixture.enroll("selected old password")).rejects.toThrow(
    /two-secret/,
  );
  expect(retiredCredentialStatus("personal").traps).toHaveLength(0);
  expect(loadEnrollmentStateForUnlock()).toEqual(state);
});
