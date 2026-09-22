/**
 * Unit coverage for PIN/passkey unlock duress gates.
 */

import { describe, expect, it, vi } from "vitest";
import { unlockWithPasskeyAfterDuressGate } from "../../../screens/unlock/unlock-passkey-duress.js";
import type { UnlockDuressOutcome } from "../../../sections/settings/security/duress-unlock-bridge.js";
import { WrongPasswordError } from "../../vault/crypto.js";
import type { SealedSlot } from "../crypto/slot-profile.js";

function lockedDuressOutcome(presentation = "locked"): UnlockDuressOutcome {
  const slot: SealedSlot = {
    version: 1,
    slotId: "slot-1",
    profileId: "p-locked",
    vaultRef: "vault",
    deviceBindingRef: "device",
    policyRevision: 1,
    keyEpoch: 1,
    saltB64: "AA==",
    ivB64: "AAAAAAAAAAAA",
    ciphertextB64: "AA==",
    iterations: 1,
  };
  return {
    kind: "duress",
    match: {
      status: "matched",
      profileId: "p-locked",
      triggerKind: "application_code",
      plaintext: {
        compartmentKey: crypto.getRandomValues(new Uint8Array(32)),
        actionCapability: null,
        presentation,
      },
      enrolled: {
        slot,
        triggerKind: "application_code",
      },
    },
  };
}

describe("passkey duress gate", () => {
  it("allows passkey when duress is inactive", async () => {
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
    ).resolves.toBe("vault_opened");
    expect(unlockWithPasskey).toHaveBeenCalledOnce();
    expect(probePasskeyPrf).not.toHaveBeenCalled();
  });
});

describe("pin duress gate kinds", () => {
  it("opens vault when duress is inactive", async () => {
    const { unlockWithPinAfterDuressGate } = await import(
      "../../../screens/unlock/unlock-pin-duress.js"
    );
    const unlockWithPin = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await expect(
      unlockWithPinAfterDuressGate({ unlockWithPin, createGuest }, "11223344", {
        requireDurable: false,
      }),
    ).resolves.toBe("vault_opened");
    expect(unlockWithPin).toHaveBeenCalledOnce();
  });
});

describe("passkey duress code completion", () => {
  it("completePasskeyDuressCode without evidence looks like a wrong passkey", async () => {
    const { completePasskeyDuressCode, cancelPasskeyDuressCode } = await import(
      "../../../screens/unlock/unlock-passkey-duress.js"
    );
    cancelPasskeyDuressCode();
    const unlockWithPasskey = vi.fn(async () => undefined);
    const probePasskeyPrf = vi.fn(async () => new ArrayBuffer(32));
    const unlockWithHeldPrf = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await expect(
      completePasskeyDuressCode(
        { unlockWithPasskey, probePasskeyPrf, unlockWithHeldPrf, createGuest },
        "11223344",
        { requireDurable: false },
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WrongPasswordError &&
        err.message === "That passkey did not unlock the vault.",
    );
  });
});

describe("pin duress gate injected outcomes", () => {
  it("pin gate refuses throttled outcomes", async () => {
    const { unlockWithPinAfterDuressGate } = await import(
      "../../../screens/unlock/unlock-pin-duress.js"
    );
    const unlockWithPin = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await expect(
      unlockWithPinAfterDuressGate({ unlockWithPin, createGuest }, "11223344", {
        requireDurable: false,
        submit: async () => ({ kind: "throttled" }),
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WrongPasswordError &&
        err.message === "That PIN did not unlock the vault.",
    );
    expect(unlockWithPin).not.toHaveBeenCalled();
  });

  it("pin gate refuses ambiguous and stale_policy the same way", async () => {
    const { unlockWithPinAfterDuressGate } = await import(
      "../../../screens/unlock/unlock-pin-duress.js"
    );
    for (const kind of ["ambiguous", "stale_policy"] as const) {
      const unlockWithPin = vi.fn(async () => undefined);
      const createGuest = vi.fn(async () => undefined);
      await expect(
        unlockWithPinAfterDuressGate(
          { unlockWithPin, createGuest },
          "11223344",
          {
            requireDurable: false,
            submit: async () => ({ kind }),
          },
        ),
      ).rejects.toBeInstanceOf(WrongPasswordError);
      expect(unlockWithPin, kind).not.toHaveBeenCalled();
    }
  });

  it("pin gate defaults requireDurable to true when omitted", async () => {
    const { unlockWithPinAfterDuressGate } = await import(
      "../../../screens/unlock/unlock-pin-duress.js"
    );
    const seen: Array<boolean | undefined> = [];
    const unlockWithPin = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await unlockWithPinAfterDuressGate(
      { unlockWithPin, createGuest },
      "11223344",
      {
        submit: async (_code, options) => {
          seen.push(options.requireDurable);
          return { kind: "inactive" };
        },
      },
    );
    expect(seen).toEqual([true]);
    expect(unlockWithPin).toHaveBeenCalledOnce();
  });

  it("pin gate passes requireDurable through to submit", async () => {
    const { unlockWithPinAfterDuressGate } = await import(
      "../../../screens/unlock/unlock-pin-duress.js"
    );
    const seen: Array<boolean | undefined> = [];
    const unlockWithPin = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await unlockWithPinAfterDuressGate(
      { unlockWithPin, createGuest },
      "11223344",
      {
        requireDurable: false,
        submit: async (_code, options) => {
          seen.push(options.requireDurable);
          return { kind: "inactive" };
        },
      },
    );
    expect(seen).toEqual([false]);
    expect(unlockWithPin).toHaveBeenCalledOnce();
  });

  it("pin gate locked duress keeps the wrong-PIN message", async () => {
    const { unlockWithPinAfterDuressGate } = await import(
      "../../../screens/unlock/unlock-pin-duress.js"
    );
    const unlockWithPin = vi.fn(async () => undefined);
    const createGuest = vi.fn(async () => undefined);
    await expect(
      unlockWithPinAfterDuressGate({ unlockWithPin, createGuest }, "11223344", {
        requireDurable: false,
        submit: async () => lockedDuressOutcome("locked"),
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WrongPasswordError &&
        err.message === "That PIN did not unlock the vault.",
    );
    expect(unlockWithPin).not.toHaveBeenCalled();
    expect(createGuest).not.toHaveBeenCalled();
  });
});
