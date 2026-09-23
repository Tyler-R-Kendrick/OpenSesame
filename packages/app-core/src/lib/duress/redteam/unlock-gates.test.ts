/**
 * Unit coverage for PIN/passkey unlock duress gates.
 */

import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it, vi } from "vitest";
import {
  UNLOCK_PASSKEY_MISS,
  UNLOCK_PASSWORD_MISS,
  UNLOCK_PIN_MISS,
  resolveRequireDurable,
} from "../../../screens/unlock/unlock-duress-refuse.js";
import { unlockWithPasskeyAfterDuressGate } from "../../../screens/unlock/unlock-passkey-duress.js";
import { WrongPasswordError } from "../../vault/crypto.js";

describe("resolveRequireDurable", () => {
  it("defaults to true and passes explicit false through", () => {
    expect(resolveRequireDurable({})).toBe(true);
    expect(resolveRequireDurable({ requireDurable: true })).toBe(true);
    expect(resolveRequireDurable({ requireDurable: false })).toBe(false);
  });
});

describe("unlock miss copy", () => {
  it("keeps non-empty distinct miss sentences", () => {
    expect(UNLOCK_PIN_MISS).toContain("PIN");
    expect(UNLOCK_PASSWORD_MISS).toContain("password");
    expect(UNLOCK_PASSKEY_MISS).toContain("passkey");
    expect(
      new Set([UNLOCK_PIN_MISS, UNLOCK_PASSWORD_MISS, UNLOCK_PASSKEY_MISS])
        .size,
    ).toBe(3);
  });
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
      (err: BoundaryValue) =>
        err instanceof WrongPasswordError &&
        err.message === UNLOCK_PASSKEY_MISS,
    );
  });
});
