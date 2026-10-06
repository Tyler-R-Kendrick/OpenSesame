import { afterEach, beforeEach, expect, it } from "vitest";
import {
  armPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "../duress/settings/unlock-arming.js";
import { loadEnrollmentStateForUnlock } from "../duress/store/unlock-enrollment.js";
import { retiredCredentialStatus } from "./index.js";
import { createRetiredCredentialFixture } from "./test-support.js";
let fixture: Awaited<ReturnType<typeof createRetiredCredentialFixture>>;
beforeEach(async () => {
  fixture = await createRetiredCredentialFixture();
});
afterEach(() => fixture.restore());
const code = "01234567";
const seal = () =>
  sealUnlockTriggerFromCeremony({
    code,
    profileId: "retired-collision-test",
    vaultRef: "personal",
    deviceBindingRef: "test-device",
    presentation: "decoy",
    ownerConsent: true,
    capabilities: { durableLocalStorage: true, offlineReady: true },
  });
it("refuses arming a sealed duress draft after the same code is enrolled as a retired trap", async () => {
  const draft = await seal();
  await fixture.enroll(code);
  const result = await armPersistedUnlockEnrollment(draft, {
    requireDurable: false,
  });
  expect(result.ok).toBe(false);
  expect(loadEnrollmentStateForUnlock()?.armed).not.toBe(true);
});
it("prevents concurrent trap enrollment and duress arming from both authorizing the same code", async () => {
  const draft = await seal();
  const outcomes = await Promise.allSettled([
    fixture.enroll(code),
    armPersistedUnlockEnrollment(draft, { requireDurable: false }),
  ]);
  expect(outcomes).toHaveLength(2);
  const trapped = retiredCredentialStatus("personal").traps.length > 0;
  const armed = loadEnrollmentStateForUnlock()?.armed === true;
  expect(trapped && armed).toBe(false);
  expect(trapped || armed).toBe(true);
});
it("refuses stale trap topology changes even when the added trap has another password", async () => {
  const draft = await seal();
  await fixture.enroll("another old secret");
  expect(
    (await armPersistedUnlockEnrollment(draft, { requireDurable: false })).ok,
  ).toBe(false);
});
