import { createVault } from "@opensesame/vault-core";
import { beforeEach, describe, expect, it } from "vitest";
import { onCompleteUnlockCodeSubmission } from "../../../sections/settings/security/duress-unlock-bridge.js";
import { kvDelete, kvSet } from "../../kv.js";
import { VaultStore } from "../../vault/store.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "../../vfs.js";
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
    kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
  });

  it("refuses a trigger equal to the vault's own PIN (ambiguous_trigger)", async () => {
    const store = new VaultStore();
    await store.createWithPin("48291037");
    store.lock();
    const seal = (code: string) =>
      sealUnlockTriggerFromCeremony({
        code,
        profileId: "p-pin",
        vaultRef: "vault-1",
        deviceBindingRef: "device-1",
        presentation: "decoy",
      });
    await expect(seal("48291037")).rejects.toThrow(/^ambiguous_trigger/);
    const other = await seal("48291038");
    expect(other.triggers).toHaveLength(1);
  });

  it("refuses a trigger equal to a guest vault's PIN or any vault's password", async () => {
    const store = new VaultStore();
    await store.createGuest();
    await store.enrollPin("55443322");
    store.lock();
    const { header } = await createVault("86420135");
    kvSet(tombFileKey(PERSONAL_TOMB, HEADER_PATH), JSON.stringify(header));
    for (const code of ["55443322", "86420135"]) {
      await expect(
        sealUnlockTriggerFromCeremony({
          code,
          profileId: "p-other",
          vaultRef: "vault-1",
          deviceBindingRef: "device-1",
          presentation: "restricted",
        }),
      ).rejects.toThrow(/^ambiguous_trigger/);
    }
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
