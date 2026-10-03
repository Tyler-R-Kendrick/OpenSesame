/**
 * The duress gate on the protector road (ADR 0152, INV-03), against the real
 * duress runtime: a typed key is routed through TRIGGER like a password; an
 * age-passkey tap holds its root until the complete code a two-input trigger
 * asks for has been decided.
 */

import { WrongPasswordError } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { duressSessionFence } from "../../lib/duress/session/fence.js";
import {
  armPersistedUnlockEnrollment,
  disarmPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "../../lib/duress/settings/unlock-arming.js";
import {
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
  persistEnrollmentStateForUnlock,
} from "../../lib/duress/store/unlock-enrollment.js";
import { completePasskeyDuressCode } from "./unlock-passkey-duress.js";
import {
  clearPasskeyDuressEvidence,
  hasHeldProtectorRoot,
  holdProtectorRoot,
  stashPasskeyDuressEvidence,
} from "./unlock-passkey-evidence.js";
import { unlockWithProtectorAfterDuressGate } from "./unlock-protector-duress.js";

const DURESS_CODE = "24681357";
const OPTIONS = { requireDurable: false };

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

/** Arm the real duress runtime with one code, as Settings does. */
async function arm(
  presentation: "restricted" | "locked",
  kind?: "verified_uv_then_code",
): Promise<void> {
  const sealed = await sealUnlockTriggerFromCeremony({
    code: DURESS_CODE,
    profileId: `p-${presentation}`,
    vaultRef: "vault-protector",
    deviceBindingRef: "device-protector",
    ownerConsent: true,
    capabilities: { durableLocalStorage: true, offlineReady: true },
    presentation,
  });
  await armPersistedUnlockEnrollment(sealed, OPTIONS);
  const loaded = loadEnrollmentStateForUnlock();
  const first = loaded?.triggers[0];
  if (!loaded || !first) throw new Error("expected armed enrollment");
  if (kind) {
    await persistEnrollmentStateForUnlock(
      { ...loaded, triggers: [{ ...first, triggerKind: kind }] },
      OPTIONS,
    );
  }
}

function store() {
  return {
    unlockWithProtector: vi.fn(async () => undefined),
    probeProtector: vi.fn(async () => new Uint8Array(32).fill(9).buffer),
    unlockWithHeldProtectorRoot: vi.fn(async () => undefined),
    unlockWithPasskey: vi.fn(async () => undefined),
    probePasskeyCeremony: vi.fn(async () => ({
      prfOutput: new ArrayBuffer(32),
      credentialIdB64: "cred-1",
    })),
    unlockWithHeldPrf: vi.fn(async () => undefined),
    createGuest: vi.fn(async () => undefined),
    cancelTotpChallenge: vi.fn(),
  };
}

beforeEach(async () => {
  await disarmPersistedUnlockEnrollment();
  clearEnrollmentStateForUnlock();
  clearPasskeyDuressEvidence();
  resetFence();
});

describe("a typed key", () => {
  it("opens the vault when no duress code is armed", async () => {
    const s = store();
    const input = { method: "recovery", secret: "c2VjcmV0" } as const;
    await expect(
      unlockWithProtectorAfterDuressGate(s, input, OPTIONS),
    ).resolves.toBe("vault_opened");
    expect(s.unlockWithProtector).toHaveBeenCalledWith(input);
  });

  it("opens the vault when an armed code does not match what was typed", async () => {
    await arm("restricted");
    const s = store();
    const input = { method: "age", secret: "AGE-SECRET-KEY-1XYZ" } as const;
    await expect(
      unlockWithProtectorAfterDuressGate(s, input, OPTIONS),
    ).resolves.toBe("vault_opened");
    expect(s.unlockWithProtector).toHaveBeenCalledWith(input);
  });

  it("opens the decoy, never the vault, when the duress code is typed in the key field", async () => {
    await arm("restricted");
    const s = store();
    await expect(
      unlockWithProtectorAfterDuressGate(
        s,
        { method: "recovery", secret: DURESS_CODE },
        OPTIONS,
      ),
    ).resolves.toBe("duress_session");
    expect(s.createGuest).toHaveBeenCalledOnce();
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
    expect(
      duressSessionFence.readFence().activeIncidentIds.length,
    ).toBeGreaterThan(0);
  });

  it("looks like a wrong key when the armed presentation is locked", async () => {
    await arm("locked");
    const s = store();
    await expect(
      unlockWithProtectorAfterDuressGate(
        s,
        { method: "age", secret: DURESS_CODE },
        OPTIONS,
      ),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
  });
});

describe("an age-passkey tap", () => {
  const input = { method: "agePasskey" } as const;

  it("opens the vault at once when no two-input trigger is armed", async () => {
    await arm("restricted");
    const s = store();
    await expect(
      unlockWithProtectorAfterDuressGate(s, input, OPTIONS),
    ).resolves.toBe("vault_opened");
    expect(s.unlockWithProtector).toHaveBeenCalledOnce();
    expect(s.probeProtector).not.toHaveBeenCalled();
  });

  it("holds the root and asks for the code when one is armed, then opens on a code that is not the duress code", async () => {
    await arm("restricted", "verified_uv_then_code");
    const s = store();
    await expect(
      unlockWithProtectorAfterDuressGate(s, input, OPTIONS),
    ).resolves.toBe("needs_duress_code");
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
    expect(hasHeldProtectorRoot()).toBe(true);

    await expect(
      completePasskeyDuressCode(s, "99887766", OPTIONS),
    ).resolves.toBe("vault_opened");
    expect(s.unlockWithHeldProtectorRoot).toHaveBeenCalledOnce();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("opens the decoy and wipes the held root when the code is the duress code", async () => {
    await arm("restricted", "verified_uv_then_code");
    const s = store();
    await unlockWithProtectorAfterDuressGate(s, input, OPTIONS);
    await expect(
      completePasskeyDuressCode(s, DURESS_CODE, OPTIONS),
    ).resolves.toBe("duress_session");
    expect(s.unlockWithHeldProtectorRoot).not.toHaveBeenCalled();
    expect(s.createGuest).toHaveBeenCalledOnce();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("forgets the held root when the ceremony is cancelled", async () => {
    await arm("restricted", "verified_uv_then_code");
    await unlockWithProtectorAfterDuressGate(store(), input, OPTIONS);
    expect(hasHeldProtectorRoot()).toBe(true);
    clearPasskeyDuressEvidence();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("zeroes a held root it has no way to spend before refusing", async () => {
    await arm("restricted", "verified_uv_then_code");
    const s = store();
    const held = new Uint8Array(32).fill(9);
    holdProtectorRoot(held.buffer, "agePasskey");
    stashPasskeyDuressEvidence({ userVerified: true, prfOutput: null });
    const { unlockWithHeldProtectorRoot: _unspendable, ...incapable } = s;
    await expect(
      completePasskeyDuressCode(incapable, "99887766", OPTIONS),
    ).rejects.toBeInstanceOf(WrongPasswordError);
    expect([...held].every((byte) => byte === 0)).toBe(true);
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("refuses a code with nothing held, as a wrong passkey", async () => {
    await expect(
      completePasskeyDuressCode(store(), "99887766", OPTIONS),
    ).rejects.toBeInstanceOf(WrongPasswordError);
  });
});
