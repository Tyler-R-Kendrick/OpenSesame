import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { kvDelete } from "../../kv.js";
import { passwordSeams } from "../../vault/password.js";
import { VaultStore } from "../../vault/store.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "../../vfs.js";
import { codeOpensDuressTrigger } from "../store/duress-code-probe.js";
import { clearEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";
import {
  armPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "./unlock-arming.js";

/** Digits only and inside the PIN length window, as a duress code must be. */
const DURESS = "739104628351";
const AMBIGUOUS = /^ambiguous_trigger/;

async function armDuress(code: string): Promise<void> {
  const sealed = await sealUnlockTriggerFromCeremony({
    code,
    profileId: "p-decoy",
    vaultRef: "vault-1",
    deviceBindingRef: "device-1",
    presentation: "decoy",
    opensOrdinaryUnlock: async () => false,
  });
  const armed = await armPersistedUnlockEnrollment(sealed, {
    requireDurable: false,
  });
  expect(armed.ok).toBe(true);
}

// The reverse of unlock-arming.test.ts's "trigger equal to the vault's own
// PIN": here the trigger came first and the ordinary secret is the newcomer.
describe("an ordinary unlock secret may not equal an armed duress code", () => {
  beforeEach(() => {
    clearEnrollmentStateForUnlock();
    kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes without a persisted enrollment as no collision", async () => {
    expect(await codeOpensDuressTrigger(DURESS)).toBe(false);
  });

  it("refuses a first-run PIN equal to the duress code", async () => {
    await armDuress(DURESS);
    const store = new VaultStore();
    await expect(store.createWithPin(DURESS)).rejects.toThrow(AMBIGUOUS);
    expect(store.getSnapshot().status).toBe("empty");
    await store.createWithPin("48291037");
    expect(store.getSnapshot().status).toBe("unlocked");
    await store.destroy();
  });

  it("refuses enrolling a PIN equal to the duress code, guest included", async () => {
    await armDuress(DURESS);
    const store = new VaultStore();
    await store.createGuest();
    await expect(store.enrollPin(DURESS)).rejects.toThrow(AMBIGUOUS);
    await store.enrollPin("55443322");
    store.lock();
    await expect(store.unlockWithPin(DURESS)).rejects.toThrow();
  });

  // Today's strength floor already rejects an all-digit password this short,
  // so the estimator is stood in for: the duress check must hold on its own
  // if that floor ever moves.
  it("refuses a master password equal to the duress code on every path", async () => {
    vi.spyOn(passwordSeams, "estimateStrength").mockReturnValue({
      bits: 70,
      score: 3,
      label: "Strong",
    });
    await armDuress(DURESS);
    const store = new VaultStore();
    await expect(store.create(DURESS)).rejects.toThrow(AMBIGUOUS);
    await store.createGuest();
    await expect(store.enrollPassword(DURESS)).rejects.toThrow(AMBIGUOUS);
    const password = "quiet-harbor-lantern-42";
    await store.enrollPassword(password);
    await expect(store.changeMasterPassword(password, DURESS)).rejects.toThrow(
      AMBIGUOUS,
    );
  });
});
