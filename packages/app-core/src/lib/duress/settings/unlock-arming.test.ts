import { beforeEach, describe, expect, it } from "vitest";
import { onCompleteUnlockCodeSubmission } from "../../../sections/settings/security/duress-unlock-bridge.js";
import { duressSessionFence } from "../session/fence.js";
import {
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
} from "../store/unlock-enrollment.js";
import {
  armPersistedUnlockEnrollment,
  disarmPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "./unlock-arming.js";

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) {
    duressSessionFence.resolve(ids, true);
  }
}

describe("production unlock arming path", () => {
  beforeEach(() => {
    clearEnrollmentStateForUnlock();
    resetFence();
  });

  it("seal → arm → complete code activates duress and skips normal", async () => {
    const sealed = await sealUnlockTriggerFromCeremony({
      code: "01234567",
      profileId: "p-alert",
      vaultRef: "vault-1",
      deviceBindingRef: "device-1",
      presentation: "restricted",
    });
    expect(sealed.armed).toBe(false);
    expect(sealed.triggers).toHaveLength(1);

    const armed = await armPersistedUnlockEnrollment(sealed, {
      requireDurable: false,
    });
    expect(armed.ok).toBe(true);
    const loaded = loadEnrollmentStateForUnlock();
    expect(loaded?.armed).toBe(true);

    const miss = await onCompleteUnlockCodeSubmission("99999999", {
      requireDurable: false,
    });
    expect(miss.kind).toBe("normal");

    const hit = await onCompleteUnlockCodeSubmission("01234567", {
      requireDurable: false,
    });
    expect(hit.kind).toBe("duress");
    if (hit.kind === "duress") {
      expect(hit.match.profileId).toBe("p-alert");
    }
    expect(
      duressSessionFence.readFence().activeIncidentIds.length,
    ).toBeGreaterThan(0);

    await disarmPersistedUnlockEnrollment();
    expect(loadEnrollmentStateForUnlock()).toBeNull();
  });
});
