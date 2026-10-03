/** @vitest-environment jsdom */
import { vaultsSeams } from "@opensesame/app-core/lib/vaults.js";
import {
  hasHeldProtectorRoot,
  holdProtectorRoot,
  peekPasskeyDuressEvidence,
  stashPasskeyDuressEvidence,
} from "@opensesame/app-core/screens/unlock/unlock-passkey-evidence.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnlockScreen, unlockScreenDependencies } from "./UnlockScreen.js";
import {
  ANSWERED,
  resetUnlockHarness,
  setupHolder,
  userMenuTrigger,
  v,
} from "./unlock-screen-harness.js";

const originalDeps = { ...unlockScreenDependencies };
const originalVaultsSeams = { ...vaultsSeams };

const vaults = [
  {
    id: "personal",
    kind: "personal" as const,
    label: "personal",
    named: true,
    sealedAt: "2026-08-14T10:00:00Z",
    state: "locked" as const,
    sharedKey: false,
  },
  {
    id: "prj_0000-4f2a",
    kind: "project" as const,
    label: "project · 4f2a",
    named: false,
    sealedAt: "2026-08-27T10:00:00Z",
    state: "locked" as const,
    sharedKey: false,
  },
];

/** What an age-passkey tap leaves behind while a code is asked for. */
function holdACeremony(): Uint8Array {
  const root = new Uint8Array(32).fill(9);
  holdProtectorRoot(root.buffer, "agePasskey");
  stashPasskeyDuressEvidence({ userVerified: true, prfOutput: null });
  return root;
}

beforeEach(() => {
  resetUnlockHarness();
  setupHolder.current = ANSWERED;
  v.state = {
    status: "locked",
    header: null,
    lockedOutUntil: null,
    failedAttempts: 0,
    durable: true,
    awaitingSecondStep: false,
  };
  v.methods = ["password"];
  v.preferred = "password";
  v.host = { ok: true };
});

afterEach(() => {
  cleanup();
  Object.assign(unlockScreenDependencies, originalDeps);
  Object.assign(vaultsSeams, originalVaultsSeams);
});

describe("UnlockScreen — what a ceremony held does not outlive the screen", () => {
  it("zeroes the held root and drops the evidence when the screen unmounts", () => {
    const { unmount } = render(<UnlockScreen />);
    const root = holdACeremony();
    expect(hasHeldProtectorRoot()).toBe(true);
    unmount();
    expect(hasHeldProtectorRoot()).toBe(false);
    expect(peekPasskeyDuressEvidence()).toBeNull();
    expect([...root].every((byte) => byte === 0)).toBe(true);
  });

  it("drops it when the person goes to all vaults", () => {
    Object.assign(vaultsSeams, {
      listDeviceVaults: () => vaults,
      deviceHasSeveralVaults: () => true,
      switchVault: async () => "locked",
    });
    Object.assign(unlockScreenDependencies, {
      deviceHasSeveralVaults: () => true,
      listDeviceVaults: () => vaults,
    });
    render(<UnlockScreen />);
    fireEvent.click(
      screen.getByText("personal", { selector: ".vault-row__name" }),
    );
    return screen.findByRole("heading", { name: "Unlock" }).then(() => {
      const root = holdACeremony();
      fireEvent.click(userMenuTrigger());
      fireEvent.click(screen.getByRole("menuitem", { name: "All vaults" }));
      expect(screen.getByRole("heading", { name: "Vaults" })).toBeTruthy();
      expect(hasHeldProtectorRoot()).toBe(false);
      expect(peekPasskeyDuressEvidence()).toBeNull();
      expect([...root].every((byte) => byte === 0)).toBe(true);
    });
  });
});
