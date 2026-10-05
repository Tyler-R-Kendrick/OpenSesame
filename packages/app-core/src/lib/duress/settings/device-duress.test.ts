import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onCompleteUnlockCodeSubmission } from "../../../sections/settings/security/duress-unlock-bridge.js";
import { kvDelete } from "../../kv.js";
import { VaultStore } from "../../vault/store.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  PERSONAL_TOMB,
  tombFileKey,
} from "../../vfs.js";
import {
  currentIncidentIntent,
  recoverDuressIncidentAfterRestart,
} from "../incident/activate.js";
import { duressSessionFence } from "../session/fence.js";
import { journalSeams } from "../store/journal.js";
import {
  clearEnrollmentStateForUnlock,
  loadEnrollmentStateForUnlock,
} from "../store/unlock-enrollment.js";
import {
  clearDuressIncidents,
  duressStatus,
  enableDuressCode,
  removeDuressCode,
} from "./device-duress.js";
import {
  armPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "./unlock-arming.js";

const CODE = "739104628";

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

describe("this device's duress code (ADR 0155)", () => {
  beforeEach(() => {
    clearEnrollmentStateForUnlock();
    resetFence();
    kvDelete(tombFileKey(PERSONAL_TOMB, HEADER_PATH));
    kvDelete(tombFileKey(GUEST_TOMB, HEADER_PATH));
  });

  it("is off until a code is set, and says so", () => {
    expect(duressStatus()).toEqual({ armed: false, incidents: 0 });
  });

  it("arms a code bound to the vault it was set in, and stores no plaintext", async () => {
    expect(
      await enableDuressCode({
        code: CODE,
        outcome: "decoy",
        vaultRef: "prj_a",
        requireDurable: false,
      }),
    ).toEqual({ ok: true });
    expect(duressStatus().armed).toBe(true);
    const state = loadEnrollmentStateForUnlock();
    expect(state?.vaultRef).toBe("prj_a");
    expect(JSON.stringify(state)).not.toContain(CODE);
  });

  it("opens a decoy when the outcome is decoy", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    const outcome = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    expect(outcome.kind).toBe("duress");
    if (outcome.kind === "duress") {
      expect(outcome.match.plaintext.presentation).toBe("decoy");
      outcome.match.plaintext.compartmentKey.fill(0);
    }
  });

  it("reads as a wrong password when the outcome is refuse", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "refuse",
      vaultRef: "personal",
      requireDurable: false,
    });
    const outcome = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    expect(outcome.kind).toBe("duress");
    if (outcome.kind === "duress") {
      expect(outcome.match.plaintext.presentation).toBe("locked");
      outcome.match.plaintext.compartmentKey.fill(0);
    }
  });

  it("takes the mode by id, and the legacy outcome name the same way", async () => {
    for (const [field, id, presentation] of [
      ["mode", "decoy", "decoy"],
      ["mode", "refuse", "locked"],
      ["outcome", "refuse", "locked"],
    ] as const) {
      clearEnrollmentStateForUnlock();
      resetFence();
      expect(
        await enableDuressCode({
          code: CODE,
          [field]: id,
          vaultRef: "personal",
          requireDurable: false,
        }),
      ).toEqual({ ok: true });
      const result = await onCompleteUnlockCodeSubmission(CODE, {
        requireDurable: false,
      });
      expect(result.kind).toBe("duress");
      if (result.kind === "duress") {
        expect(result.match.plaintext.presentation).toBe(presentation);
        result.match.plaintext.compartmentKey.fill(0);
      }
    }
  });

  it("refuses an unknown or missing mode, and leaves no code behind", async () => {
    for (const input of [{ mode: "wipe" }, { outcome: "wipe" }, {}]) {
      expect(
        await enableDuressCode({
          code: CODE,
          ...input,
          vaultRef: "personal",
          requireDurable: false,
        }),
      ).toEqual({ ok: false, code: "failed" });
    }
    expect(duressStatus().armed).toBe(false);
  });

  it("leaves every other code alone", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    const outcome = await onCompleteUnlockCodeSubmission("111122223", {
      requireDurable: false,
    });
    expect(outcome.kind).toBe("normal");
  });

  it("refuses a code that is not eight to twelve digits", async () => {
    for (const code of ["123", "1234567890123", "12ab56", "", "abcd"]) {
      expect(
        await enableDuressCode({
          code,
          outcome: "decoy",
          vaultRef: "personal",
          requireDurable: false,
        }),
      ).toEqual({ ok: false, code: "code_format" });
    }
    expect(duressStatus().armed).toBe(false);
  });

  it("refuses the PIN that opens a vault here", async () => {
    const store = new VaultStore();
    await store.createWithPin("48291037");
    store.lock();
    expect(
      await enableDuressCode({
        code: "48291037",
        outcome: "decoy",
        vaultRef: "personal",
        requireDurable: false,
      }),
    ).toEqual({ ok: false, code: "collides" });
    expect(duressStatus().armed).toBe(false);
    await store.destroy();
  });

  it("replaces the code, so the old one stops matching", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    await enableDuressCode({
      code: "556677889",
      outcome: "refuse",
      vaultRef: "personal",
      requireDurable: false,
    });
    expect(
      (await onCompleteUnlockCodeSubmission(CODE, { requireDurable: false }))
        .kind,
    ).toBe("normal");
    const now = await onCompleteUnlockCodeSubmission("556677889", {
      requireDurable: false,
    });
    expect(now.kind).toBe("duress");
    if (now.kind === "duress") now.match.plaintext.compartmentKey.fill(0);
  });

  it("removes the code, and unlock is ordinary again", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    expect(await removeDuressCode()).toEqual({ ok: true });
    expect(duressStatus().armed).toBe(false);
    expect(
      (await onCompleteUnlockCodeSubmission(CODE, { requireDurable: false }))
        .kind,
    ).toBe("inactive");
  });

  it("leaves the device fenced after the code is used, until the owner clears it", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    const outcome = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    if (outcome.kind === "duress")
      outcome.match.plaintext.compartmentKey.fill(0);
    expect(duressStatus().incidents).toBe(1);
    expect(
      await enableDuressCode({
        code: "556677889",
        outcome: "decoy",
        vaultRef: "personal",
        requireDurable: false,
      }),
    ).toEqual({ ok: false, code: "incident_active" });
    expect(currentIncidentIntent()).not.toBeNull();
    expect(await clearDuressIncidents()).toEqual({
      ok: true,
      status: { armed: true, incidents: 0 },
    });
    expect(currentIncidentIntent()).toBeNull();
    expect(recoverDuressIncidentAfterRestart().recovered).toBe(false);
    expect(duressStatus().incidents).toBe(0);
    expect(
      await enableDuressCode({
        code: "556677889",
        outcome: "decoy",
        vaultRef: "personal",
        requireDurable: false,
      }),
    ).toEqual({ ok: true });
  });
});

const seams = { ...journalSeams };

describe("what the owner is told matches what storage holds", () => {
  beforeEach(() => {
    clearEnrollmentStateForUnlock();
    resetFence();
  });
  afterEach(() => {
    Object.assign(journalSeams, seams);
  });

  async function armAndUse(): Promise<void> {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    const outcome = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    if (outcome.kind === "duress")
      outcome.match.plaintext.compartmentKey.fill(0);
  }

  it("keeps one code per device, even over a code set under another profile", async () => {
    const legacy = await sealUnlockTriggerFromCeremony({
      code: "111122223",
      profileId: "legacy-preset",
      vaultRef: "personal",
      deviceBindingRef: "this-browser",
      presentation: "decoy",
      ownerConsent: true,
      capabilities: { durableLocalStorage: true, offlineReady: true },
    });
    await armPersistedUnlockEnrollment(legacy, { requireDurable: false });
    expect(
      await enableDuressCode({
        code: CODE,
        outcome: "decoy",
        vaultRef: "personal",
        requireDurable: false,
      }),
    ).toEqual({ ok: true });
    expect(loadEnrollmentStateForUnlock()?.triggers).toHaveLength(1);
    const old = await onCompleteUnlockCodeSubmission("111122223", {
      requireDurable: false,
    });
    expect(old.kind).toBe("normal");
    const now = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    expect(now.kind).toBe("duress");
    if (now.kind === "duress") now.match.plaintext.compartmentKey.fill(0);
  });

  it("does not leave a code live when storage refuses it", async () => {
    journalSeams.durability = () => "persistent";
    journalSeams.setDurable = async () => {
      throw new Error("storage refused the write: quota");
    };
    expect(
      await enableDuressCode({
        code: CODE,
        outcome: "decoy",
        vaultRef: "personal",
      }),
    ).toEqual({ ok: false, code: "not_durable" });
    expect(duressStatus().armed).toBe(false);
    const outcome = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    expect(outcome.kind).toBe("inactive");
  });

  it("keeps the code it had when storage refuses a replacement", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    journalSeams.durability = () => "persistent";
    journalSeams.setDurable = async () => {
      throw new Error("storage refused the write");
    };
    expect(
      await enableDuressCode({
        code: "556677889",
        outcome: "refuse",
        vaultRef: "personal",
      }),
    ).toEqual({ ok: false, code: "not_durable" });
    const refused = await onCompleteUnlockCodeSubmission("556677889", {
      requireDurable: false,
    });
    expect(refused.kind).toBe("normal");
    // Storage is back: using the code it kept writes an incident journal.
    Object.assign(journalSeams, seams);
    const kept = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    expect(kept.kind).toBe("duress");
    if (kept.kind === "duress") kept.match.plaintext.compartmentKey.fill(0);
  });

  it("does not say the code is removed while storage still holds it", async () => {
    await enableDuressCode({
      code: CODE,
      outcome: "decoy",
      vaultRef: "personal",
      requireDurable: false,
    });
    journalSeams.deleteDurable = async () => {
      throw new Error("storage refused the delete");
    };
    expect(await removeDuressCode()).toEqual({ ok: false, code: "failed" });
  });

  it("does not say the incident is cleared while storage still holds it", async () => {
    await armAndUse();
    expect(duressStatus().incidents).toBe(1);
    journalSeams.deleteDurable = async () => {
      throw new Error("storage refused the delete");
    };
    expect(await clearDuressIncidents()).toEqual({ ok: false, code: "failed" });
    // The fence is untouched, so the owner can try again.
    expect(duressStatus().incidents).toBe(1);
    expect(currentIncidentIntent()).not.toBeNull();
    Object.assign(journalSeams, seams);
    expect((await clearDuressIncidents()).ok).toBe(true);
    expect(duressStatus().incidents).toBe(0);
  });
});
