/**
 * The duress gate on the protector road (ADR 0152, INV-03): a typed key is
 * routed through TRIGGER like a password; an age-passkey tap holds its root
 * until the complete code a two-input trigger asks for has been decided.
 */
import { WrongPasswordError } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  outcome: { kind: "inactive" } as { kind: string; match?: unknown },
  armed: false,
  codes: [] as string[],
}));

vi.mock("../../sections/settings/security/duress-unlock-bridge.js", () => ({
  loadEnrollmentStateForUnlock: () =>
    bridge.armed
      ? { armed: true, triggers: [{ triggerKind: "verified_uv_then_code" }] }
      : null,
  onCompleteUnlockCodeSubmission: async (code: string) => {
    bridge.codes.push(code);
    return bridge.outcome;
  },
}));

const decoy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./unlock-duress-continue.js", () => ({
  continueAfterDuressMatch: async () => {
    decoy.calls += 1;
    return "duress_session";
  },
}));

import { completePasskeyDuressCode } from "./unlock-passkey-duress.js";
import {
  clearPasskeyDuressEvidence,
  hasHeldProtectorRoot,
} from "./unlock-passkey-evidence.js";
import { unlockWithProtectorAfterDuressGate } from "./unlock-protector-duress.js";

const DURESS = {
  kind: "duress",
  match: { profileId: "p", plaintext: { presentation: "decoy" } },
};

function store() {
  const root = new Uint8Array(32).fill(9);
  return {
    unlockWithProtector: vi.fn(async () => undefined),
    probeProtector: vi.fn(async () => root.buffer.slice(0)),
    unlockWithHeldProtectorRoot: vi.fn(async () => undefined),
    unlockWithPasskey: vi.fn(async () => undefined),
    probePasskeyPrf: vi.fn(async () => new ArrayBuffer(32)),
    unlockWithHeldPrf: vi.fn(async () => undefined),
    createGuest: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  bridge.outcome = { kind: "inactive" };
  bridge.armed = false;
  bridge.codes = [];
  decoy.calls = 0;
  clearPasskeyDuressEvidence();
});

describe("a typed key", () => {
  it("opens the vault when no duress code matches", async () => {
    const s = store();
    const input = { method: "recovery", secret: "abc" } as const;
    for (const kind of ["inactive", "normal"]) {
      bridge.outcome = { kind };
      await expect(unlockWithProtectorAfterDuressGate(s, input)).resolves.toBe(
        "vault_opened",
      );
    }
    expect(s.unlockWithProtector).toHaveBeenCalledWith(input);
    // What was typed went to TRIGGER before anything was unwrapped.
    expect(bridge.codes).toEqual(["abc", "abc"]);
  });

  it("opens the decoy, never the vault, when the duress code is typed in the key field", async () => {
    const s = store();
    bridge.outcome = DURESS;
    await expect(
      unlockWithProtectorAfterDuressGate(s, { method: "age", secret: "1234" }),
    ).resolves.toBe("duress_session");
    expect(decoy.calls).toBe(1);
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
  });

  it("looks like a wrong key when TRIGGER is throttled or ambiguous", async () => {
    const s = store();
    for (const kind of ["throttled", "ambiguous", "stale_policy"]) {
      bridge.outcome = { kind };
      await expect(
        unlockWithProtectorAfterDuressGate(s, {
          method: "recovery",
          secret: "abc",
        }),
      ).rejects.toBeInstanceOf(WrongPasswordError);
    }
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
  });
});

describe("an age-passkey tap", () => {
  const input = { method: "agePasskey" } as const;

  it("opens the vault at once when no two-input trigger is armed", async () => {
    const s = store();
    await expect(unlockWithProtectorAfterDuressGate(s, input)).resolves.toBe(
      "vault_opened",
    );
    expect(s.unlockWithProtector).toHaveBeenCalledOnce();
    expect(s.probeProtector).not.toHaveBeenCalled();
  });

  it("holds the root and asks for the code when one is armed", async () => {
    bridge.armed = true;
    const s = store();
    await expect(unlockWithProtectorAfterDuressGate(s, input)).resolves.toBe(
      "needs_duress_code",
    );
    expect(s.unlockWithProtector).not.toHaveBeenCalled();
    expect(hasHeldProtectorRoot()).toBe(true);

    bridge.outcome = { kind: "normal" };
    await expect(completePasskeyDuressCode(s, "4821")).resolves.toBe(
      "vault_opened",
    );
    expect(s.unlockWithHeldProtectorRoot).toHaveBeenCalledOnce();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("opens the decoy and wipes the held root when the code is the duress code", async () => {
    bridge.armed = true;
    const s = store();
    await unlockWithProtectorAfterDuressGate(s, input);
    bridge.outcome = DURESS;
    await expect(completePasskeyDuressCode(s, "1234")).resolves.toBe(
      "duress_session",
    );
    expect(s.unlockWithHeldProtectorRoot).not.toHaveBeenCalled();
    expect(hasHeldProtectorRoot()).toBe(false);
  });

  it("keeps the tap for a retry when the code is throttled", async () => {
    bridge.armed = true;
    const s = store();
    await unlockWithProtectorAfterDuressGate(s, input);
    bridge.outcome = { kind: "throttled" };
    await expect(completePasskeyDuressCode(s, "0000")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    expect(hasHeldProtectorRoot()).toBe(true);
    bridge.outcome = { kind: "normal" };
    await expect(completePasskeyDuressCode(s, "4821")).resolves.toBe(
      "vault_opened",
    );
  });

  it("forgets the held root when the ceremony is cancelled", async () => {
    bridge.armed = true;
    await unlockWithProtectorAfterDuressGate(store(), input);
    clearPasskeyDuressEvidence();
    expect(hasHeldProtectorRoot()).toBe(false);
  });
});
