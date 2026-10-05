/**
 * After a wipe, the owner can recover (ADR 0168). The unlock match still fences
 * the device, and the fence is only cleared from the Duress row of an open,
 * non-guest vault. So the walk is: wipe, seal a new vault, restore the backup
 * made before the wipe, see the code marked used, clear it, arm a new code. Every
 * step runs against the real fence, the real incident journals and the real
 * vault store; nothing here resolves the fence by hand until the owner does.
 */

import { WrongPasswordError, createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockWithPinAfterDuressGate } from "../../../screens/unlock/unlock-pin-duress.js";
import { kvFlush, kvForgetAll, kvHydrate } from "../../kv.js";
import {
  offlineBackupFile,
  sealedVaultText,
} from "../../vault/offline-backup-file.js";
import { vaultStore } from "../../vault/store.js";
import { loadIncidentIntent } from "../incident/intent-journal.js";
import { duressSessionFence } from "../session/fence.js";
import {
  clearDuressIncidents,
  duressStatus,
  enableDuressCode,
  removeDuressCode,
} from "../settings/device-duress.js";
import { clearEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";
import {
  type FakeOpfs,
  installOpfs,
  makeOpfs,
} from "./fake-opfs.test-support.js";
import { allowRealWipe } from "./test-guard.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const OLD_PIN = "48291037";
const NEW_PIN = "90210384";
const WIPE_CODE = "739104628";
const NEXT_CODE = "135792468";

let opfs: FakeOpfs;

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

const vaultFileNames = () =>
  [...opfs.files.keys()].filter((name) => name.includes("tomb_personal_"));

const fenced = () => duressSessionFence.readFence().activeIncidentIds.length;

beforeEach(async () => {
  opfs = makeOpfs();
  installOpfs(opfs);
  kvForgetAll();
  clearEnrollmentStateForUnlock();
  resetFence();
  await kvHydrate([]);
  vaultStore.rehydrate();
});
afterEach(async () => {
  vaultStore.lock();
  resetFence();
  clearEnrollmentStateForUnlock();
  await kvFlush();
  vi.unstubAllGlobals();
});

describe("a wiped device recovers", () => {
  it("seals a new vault, restores the backup, sees the code used, clears it, and arms a new one", async () => {
    allowRealWipe();
    // The owner's vault, with something in it, and a backup made while they could.
    await vaultStore.createWithPin(OLD_PIN);
    await vaultStore.saveItem(createItem("note", "Passport number"));
    await vaultStore.flushPendingWrites();
    const { header, tomb } = vaultStore.getSnapshot();
    const backup = offlineBackupFile({
      status: "unlocked",
      guest: false,
      tomb,
      header,
    }).text;
    expect(
      await enableDuressCode({
        code: WIPE_CODE,
        mode: "wipe",
        extras: { confirm: "WIPE" },
        vaultRef: "personal",
      }),
    ).toEqual({ ok: true });
    vaultStore.lock();
    await kvFlush();

    // The code is typed. The device is wiped, and held.
    const typed = await unlockWithPinAfterDuressGate(
      vaultStore,
      WIPE_CODE,
    ).catch((error: unknown) => error);
    expect(typed).toBeInstanceOf(WrongPasswordError);
    expect(vaultFileNames()).toEqual([]);
    expect(fenced()).toBeGreaterThan(0);
    expect(loadIncidentIntent()).not.toBeNull();
    expect(duressStatus()).toEqual({ armed: true, incidents: fenced() });

    // (a) A brand-new vault seals on a held device, and is the owner's, not a guest's.
    await vaultStore.createWithPin(NEW_PIN);
    const fresh = vaultStore.getSnapshot();
    expect(fresh.status).toBe("unlocked");
    expect(fresh.guest).toBe(false);
    expect(fenced()).toBeGreaterThan(0);

    // (b) The backup made before the wipe restores into it, with its own PIN.
    const added = await vaultStore.importSealed(
      sealedVaultText(backup),
      OLD_PIN,
    );
    expect(added).toBe(1);
    expect(vaultStore.getSnapshot().items.map((item) => item.name)).toEqual([
      "Passport number",
    ]);

    // (c) The Duress row says used, and clearing it works from this session.
    expect(duressStatus().incidents).toBeGreaterThan(0);
    const cleared = await clearDuressIncidents();
    expect(cleared).toEqual({
      ok: true,
      status: { armed: true, incidents: 0 },
    });
    expect(fenced()).toBe(0);
    expect(loadIncidentIntent()).toBeNull();

    // (d) A new code arms, and an armed one can be taken off.
    expect(
      await enableDuressCode({
        code: NEXT_CODE,
        mode: "refuse",
        vaultRef: "personal",
      }),
    ).toEqual({ ok: true });
    expect(await removeDuressCode()).toEqual({ ok: true });
    expect(duressStatus()).toEqual({ armed: false, incidents: 0 });
  });

  it("holds the fence while a real vault exists: nothing but the owner's own clear lifts it", async () => {
    allowRealWipe();
    await vaultStore.createWithPin(OLD_PIN);
    expect(
      await enableDuressCode({
        code: WIPE_CODE,
        mode: "refuse",
        vaultRef: "personal",
      }),
    ).toEqual({ ok: true });
    vaultStore.lock();
    await kvFlush();
    // A refuse code fences the device and removes nothing.
    await unlockWithPinAfterDuressGate(vaultStore, WIPE_CODE).catch(() => null);
    expect(vaultFileNames().length).toBeGreaterThan(0);
    expect(fenced()).toBeGreaterThan(0);

    // The attacker's way out is not a new code, nor a removed one.
    expect(
      await enableDuressCode({
        code: NEXT_CODE,
        mode: "refuse",
        vaultRef: "personal",
      }),
    ).toEqual({ ok: false, code: "incident_active" });
    expect(await removeDuressCode()).toEqual({
      ok: false,
      code: "incident_active",
    });
    expect(fenced()).toBeGreaterThan(0);

    // And a vault that opens by its real PIN is still the fenced owner's: the
    // Duress row, the only road to clear, is drawn to it and no one else.
    await vaultStore.unlockWithPin(OLD_PIN);
    expect(vaultStore.getSnapshot().guest).toBe(false);
    expect(fenced()).toBeGreaterThan(0);
  });
});
