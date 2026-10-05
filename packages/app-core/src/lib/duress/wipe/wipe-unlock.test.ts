/**
 * The wipe, end to end through the real unlock path: a real vault sealed with
 * real crypto, the real kv and travel storage over an inspectable origin file
 * system, a wipe code armed through the sheet's own function and typed where a
 * password is typed. The refusal is a wrong password's, the vault is gone, and
 * the code still works. With the runner refused, the vault survives.
 */

import { WrongPasswordError, createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNLOCK_PIN_MISS } from "../../../screens/unlock/unlock-duress-refuse.js";
import { unlockWithPinAfterDuressGate } from "../../../screens/unlock/unlock-pin-duress.js";
import { onCompleteUnlockCodeSubmission } from "../../../sections/settings/security/duress-unlock-bridge.js";
import { kvFileName, kvFlush, kvForgetAll, kvHydrate, kvSetDurable } from "../../kv.js";
import { vaultStore } from "../../vault/store.js";
import { listDeviceVaults } from "../../vaults.js";
import {
  GUEST_TOMB,
  HEADER_PATH,
  registerTomb,
  tombFileKey,
} from "../../vfs.js";
import { duressSessionFence } from "../session/fence.js";
import { enableDuressCode, duressStatus } from "../settings/device-duress.js";
import { DURESS_BOOT_KEYS } from "../store/boot-keys.js";
import { clearEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";
import {
  type FakeOpfs,
  installOpfs,
  makeOpfs,
} from "./fake-opfs.test-support.js";
import { wipeGuard } from "./guard.js";
import { allowRealWipe } from "./test-guard.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const PIN = "48291037";
const CODE = "739104628";

let opfs: FakeOpfs;

/** A device with a sealed personal vault, a guest tomb and no code. */
async function freshDevice(): Promise<void> {
  opfs = makeOpfs();
  installOpfs(opfs);
  kvForgetAll();
  clearEnrollmentStateForUnlock();
  await kvHydrate([]);
  vaultStore.rehydrate();
  await vaultStore.createWithPin(PIN);
  await vaultStore.addFolder("Trips");
  await vaultStore.flushPendingWrites();
  vaultStore.lock();
  const { header } = await createVault("correct horse battery staple");
  await registerTomb(GUEST_TOMB);
  await kvSetDurable(tombFileKey(GUEST_TOMB, HEADER_PATH), JSON.stringify(header));
  await kvFlush();
}

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

const vaultFileNames = () =>
  [...opfs.files.keys()].filter((name) => name.includes("tomb_personal_"));

async function arm(): Promise<void> {
  expect(
    await enableDuressCode({
      code: CODE,
      mode: "wipe",
      extras: { confirm: "WIPE" },
      vaultRef: "personal",
    }),
  ).toEqual({ ok: true });
  await kvFlush();
}

/** The message an ordinary wrong password gets, through the same gate. */
async function ordinaryRefusal(): Promise<string> {
  const refused = await unlockWithPinAfterDuressGate(
    vaultStore,
    "13572468",
  ).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(WrongPasswordError);
  return (refused as Error).message;
}

beforeEach(freshDevice);
afterEach(async () => {
  vaultStore.lock();
  resetFence();
  clearEnrollmentStateForUnlock();
  await kvFlush();
  vi.unstubAllGlobals();
});

describe("wipe through the real unlock path", () => {
  it("refuses like a wrong password, and the vault is gone", async () => {
    allowRealWipe();
    expect(vaultFileNames().length).toBeGreaterThan(0);
    await arm();
    // Arming only proves the slot opens: every vault file is still there.
    expect(vaultFileNames().length).toBeGreaterThan(0);
    const ordinary = await ordinaryRefusal();
    const guestBefore = new Map(
      [...opfs.files].filter(([name]) => name.includes("tomb_guest_")),
    );
    expect(guestBefore.size).toBeGreaterThan(0);

    const typed = await unlockWithPinAfterDuressGate(
      vaultStore,
      CODE,
    ).catch((error: unknown) => error);

    expect(typed).toBeInstanceOf(WrongPasswordError);
    expect((typed as Error).message).toBe(ordinary);
    expect((typed as Error).message).toBe(UNLOCK_PIN_MISS);
    expect(wipeGuard.takeReached()).toEqual([]);

    // The vault is gone from storage and from the app's view of it.
    expect(vaultFileNames()).toEqual([]);
    await expect(vaultStore.unlockWithPin(PIN)).rejects.toThrow();
    expect(vaultStore.getSnapshot().status).not.toBe("unlocked");
    expect(
      listDeviceVaults().filter(
        (vault) => vault.kind !== "guest" && vault.state !== "empty",
      ),
    ).toEqual([]);

    // The guest tomb is byte for byte what it was, and the code is still armed.
    for (const [name, text] of guestBefore) expect(opfs.files.get(name)).toBe(text);
    expect(duressStatus().armed).toBe(true);
    expect(opfs.files.has(kvFileName("duress.enrollment-state.v1"))).toBe(true);

    // A new page: the boot hydrate reads the code back, and it still matches.
    kvForgetAll();
    await kvHydrate([...DURESS_BOOT_KEYS]);
    expect(duressStatus().armed).toBe(true);
    resetFence();
    const again = await onCompleteUnlockCodeSubmission(CODE, {
      requireDurable: false,
    });
    expect(again.kind).toBe("duress");
    if (again.kind === "duress") again.match.plaintext.compartmentKey.fill(0);
  });

  it("with the runner refused, the same code leaves the vault where it was", async () => {
    // Negative control: nothing is opted in, so the real runner refuses and
    // records that it was reached. Everything else is the test above.
    wipeGuard.forbid();
    await arm();
    const typed = await unlockWithPinAfterDuressGate(
      vaultStore,
      CODE,
    ).catch((error: unknown) => error);
    expect(typed).toBeInstanceOf(WrongPasswordError);
    expect(wipeGuard.takeReached()).toEqual(["runWipeEffect"]);
    expect(vaultFileNames().length).toBeGreaterThan(0);
    resetFence();
    await vaultStore.unlockWithPin(PIN);
    expect(vaultStore.getSnapshot().status).toBe("unlocked");
  });
});
