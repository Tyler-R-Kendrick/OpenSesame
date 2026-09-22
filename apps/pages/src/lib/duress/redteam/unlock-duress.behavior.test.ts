/**
 * Behaviour journey: armed application_code → PIN match → guest continue.
 * Given/When/Then without a second BDD framework (docs/testing/test-strategy.md).
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNLOCK_PIN_MISS } from "../../../screens/unlock/unlock-duress-refuse.js";
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

  it("Given armed UV+code trigger, When passkey alone, Then root stays sealed pending code", async () => {
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
    const probePasskeyPrf = vi.fn(async () => new ArrayBuffer(32));
    const unlockWithHeldPrf = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await expect(
      unlockWithPasskeyAfterDuressGate({
        unlockWithPasskey,
        probePasskeyPrf,
        unlockWithHeldPrf,
        createGuest,
      }),
    ).resolves.toBe("needs_duress_code");
    expect(unlockWithPasskey).not.toHaveBeenCalled();
    expect(probePasskeyPrf).toHaveBeenCalledOnce();
    expect(unlockWithHeldPrf).not.toHaveBeenCalled();

    clearEnrollmentStateForUnlock();
    resetFence();
  });

  it("Given armed code, When wrong PIN repeats past throttle, Then miss surface holds", async () => {
    const sealed = await sealUnlockTriggerFromCeremony({
      code: "97531864",
      profileId: "p-throttle",
      vaultRef: "vault-behaviour",
      deviceBindingRef: "device-behaviour",
      presentation: "restricted",
    });
    await armPersistedUnlockEnrollment(sealed, { requireDurable: false });

    const store = {
      unlockWithPin: vi.fn(async () => {
        throw new WrongPasswordError(UNLOCK_PIN_MISS);
      }),
      createGuest: vi.fn(async () => undefined),
    };
    for (let i = 0; i < 8; i++) {
      await expect(
        unlockWithPinAfterDuressGate(store, "00000000", {
          requireDurable: false,
        }),
      ).rejects.toBeInstanceOf(WrongPasswordError);
    }
    await expect(
      unlockWithPinAfterDuressGate(store, "00000000", {
        requireDurable: false,
      }),
    ).rejects.toSatisfy(
      (err: BoundaryValue) =>
        err instanceof WrongPasswordError && err.message === UNLOCK_PIN_MISS,
    );
    expect(store.unlockWithPin).toHaveBeenCalledTimes(8);

    await disarmPersistedUnlockEnrollment();
  });
});
