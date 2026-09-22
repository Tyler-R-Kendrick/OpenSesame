/**
 * Behaviour journey: armed application_code → PIN match → guest continue.
 * Given/When/Then without a second BDD framework (docs/testing/test-strategy.md).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { unlockWithPasskeyAfterDuressGate } from "../../../screens/unlock/unlock-passkey-duress.js";
import { unlockWithPinAfterDuressGate } from "../../../screens/unlock/unlock-pin-duress.js";
import { WrongPasswordError } from "../../vault/crypto.js";
import { duressSessionFence } from "../session/fence.js";
import {
  armPersistedUnlockEnrollment,
  disarmPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "../settings/unlock-arming.js";
import {
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../store/unlock-enrollment.js";

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) {
    duressSessionFence.resolve(ids, true);
  }
}

describe("duress unlock behaviour", () => {
  beforeEach(() => {
    clearEnrollmentStateForUnlock();
    resetFence();
  });

  it("Given armed restricted code, When PIN matches, Then guest continues without root unwrap", async () => {
    const sealed = await sealUnlockTriggerFromCeremony({
      code: "24681357",
      profileId: "p-restricted",
      vaultRef: "vault-behaviour",
      deviceBindingRef: "device-behaviour",
      presentation: "restricted",
    });
    const armed = await armPersistedUnlockEnrollment(sealed, {
      requireDurable: false,
    });
    expect(armed.ok).toBe(true);
    expect(loadEnrollmentStateForUnlock()?.armed).toBe(true);

    const unlockWithPin = vi.fn(async () => {
      throw new Error("protected root must not unwrap on duress match");
    });
    const createGuest = vi.fn(async () => undefined);

    const outcome = await unlockWithPinAfterDuressGate(
      { unlockWithPin, createGuest, cancelTotpChallenge: vi.fn() },
      "24681357",
      { requireDurable: false },
    );

    expect(outcome).toBe("duress_session");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(unlockWithPin).not.toHaveBeenCalled();
    expect(
      duressSessionFence.readFence().activeIncidentIds.length,
    ).toBeGreaterThan(0);

    await disarmPersistedUnlockEnrollment();
  });

  it("Given armed locked code, When PIN matches, Then surface looks like a wrong secret", async () => {
    const sealed = await sealUnlockTriggerFromCeremony({
      code: "13572468",
      profileId: "p-locked",
      vaultRef: "vault-behaviour",
      deviceBindingRef: "device-behaviour",
      presentation: "locked",
    });
    await armPersistedUnlockEnrollment(sealed, { requireDurable: false });

    await expect(
      unlockWithPinAfterDuressGate(
        {
          unlockWithPin: vi.fn(async () => undefined),
          createGuest: vi.fn(async () => undefined),
        },
        "13572468",
        { requireDurable: false },
      ),
    ).rejects.toBeInstanceOf(WrongPasswordError);

    await disarmPersistedUnlockEnrollment();
  });

  it("Given armed UV+code trigger, When passkey alone, Then root stays sealed", async () => {
    const sealed = await sealUnlockTriggerFromCeremony({
      code: "11223344",
      profileId: "p-uv",
      vaultRef: "vault-behaviour",
      deviceBindingRef: "device-behaviour",
      presentation: "decoy",
    });
    await armPersistedUnlockEnrollment(sealed, { requireDurable: false });
    const loaded = loadEnrollmentStateForUnlock();
    expect(loaded).not.toBeNull();
    if (!loaded || !loaded.triggers[0]) {
      throw new Error("expected armed enrollment");
    }
    await persistEnrollmentStateForUnlock(
      {
        ...loaded,
        triggers: [
          {
            ...loaded.triggers[0],
            triggerKind: "verified_uv_then_code",
          },
        ],
      },
      { requireDurable: false },
    );

    const unlockWithPasskey = vi.fn(async () => undefined);
    await expect(
      unlockWithPasskeyAfterDuressGate({ unlockWithPasskey }),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(unlockWithPasskey).not.toHaveBeenCalled();

    clearEnrollmentStateForUnlock();
    resetFence();
  });
});
