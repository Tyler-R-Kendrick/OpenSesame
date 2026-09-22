/**
 * Unit coverage for post-match unlock continue + passkey two-input refuse.
 */

import { describe, expect, it, vi } from "vitest";
import { continueAfterDuressMatch } from "../../../screens/unlock/unlock-duress-continue.js";
import { unlockWithPasskeyAfterDuressGate } from "../../../screens/unlock/unlock-passkey-duress.js";
import { WrongPasswordError } from "../../vault/crypto.js";

function continueMatch(presentation: string, profileId = "p-test") {
  return {
    profileId,
    plaintext: {
      compartmentKey: crypto.getRandomValues(new Uint8Array(32)),
      actionCapability: null,
      presentation,
    },
  };
}

describe("unlock duress continue", () => {
  it("opens guest for decoy presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    const cancelTotpChallenge = vi.fn();
    const result = await continueAfterDuressMatch(
      { createGuest, cancelTotpChallenge },
      continueMatch("decoy"),
      "That PIN did not unlock the vault.",
    );
    expect(result).toBe("duress_session");
    expect(createGuest).toHaveBeenCalledOnce();
    expect(cancelTotpChallenge).toHaveBeenCalledOnce();
  });

  it("looks like a wrong secret for locked presentation", async () => {
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        continueMatch("locked"),
        "That PIN did not unlock the vault.",
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WrongPasswordError &&
        err.message === "That PIN did not unlock the vault.",
    );
    expect(createGuest).not.toHaveBeenCalled();
  });
});

it("sets presentation runtime for decoy and clears on locked", async () => {
  const { readActivePresentation, clearActivePresentation } = await import(
    "../compartment/presentation-runtime.js"
  );
  clearActivePresentation();
  const createGuest = vi.fn(async () => undefined);
  await continueAfterDuressMatch(
    { createGuest },
    continueMatch("decoy", "p-decoy"),
    "That PIN did not unlock the vault.",
  );
  const active = readActivePresentation();
  expect(active?.profileId).toBe("p-decoy");
  expect(active?.outcome.kind).toBe("locked");
  expect(active?.view.locked).toBe(true);

  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("locked"),
      "That PIN did not unlock the vault.",
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(readActivePresentation()).toBeNull();
});

it("treats unchanged like a wrong secret", async () => {
  const createGuest = vi.fn(async () => undefined);
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("unchanged"),
      "That PIN did not unlock the vault.",
    ),
  ).rejects.toBeInstanceOf(WrongPasswordError);
  expect(createGuest).not.toHaveBeenCalled();
});

it("opens guest for normal and restricted presentations", async () => {
  for (const presentation of ["normal", "restricted"] as const) {
    const createGuest = vi.fn(async () => undefined);
    await expect(
      continueAfterDuressMatch(
        { createGuest },
        continueMatch(presentation),
        "That PIN did not unlock the vault.",
      ),
    ).resolves.toBe("duress_session");
    expect(createGuest, presentation).toHaveBeenCalledOnce();
  }
});

it("unknown presentation maps to restricted guest continue", async () => {
  const createGuest = vi.fn(async () => undefined);
  await expect(
    continueAfterDuressMatch(
      { createGuest },
      continueMatch("not-a-real-class"),
      "That PIN did not unlock the vault.",
    ),
  ).resolves.toBe("duress_session");
  expect(createGuest).toHaveBeenCalledOnce();
});

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
