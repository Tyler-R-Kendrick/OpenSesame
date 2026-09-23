/**
 * A duress decoy never destroys a sealed vault: a guest who enrolled a PIN
 * keeps their tomb whole when a trigger fires on the guest's unlock screen or
 * beside the personal vault (real VaultStore, real VFS).
 */

import { createItem, createVault } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unlockWithPinAfterDuressGate } from "../../../screens/unlock/unlock-pin-duress.js";
import { kvDelete, kvGet, kvSet } from "../../kv.js";
import { readLastVaultId } from "../../last-vault.js";
import { VaultStore } from "../../vault/store.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  PERSONAL_TOMB,
  listTombs,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { clearActivePresentation } from "../compartment/presentation-runtime.js";
import { duressSessionFence } from "../session/fence.js";
import {
  armPersistedUnlockEnrollment,
  sealUnlockTriggerFromCeremony,
} from "../settings/unlock-arming.js";
import { DECOY_SCRATCH_TOMB } from "./decoy-scratch.js";
import { clearEnrollmentStateForUnlock } from "./unlock-enrollment.js";

const GUEST_PIN = "48291037";
const DURESS_CODE = "01234567";
const GUEST_HEADER = tombFileKey(GUEST_TOMB, HEADER_PATH);
const GUEST_BODY = tombFileKey(GUEST_TOMB, BODY_PATH);
const PERSONAL_HEADER = tombFileKey(PERSONAL_TOMB, HEADER_PATH);

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

async function armDecoyTrigger(): Promise<void> {
  const sealed = await sealUnlockTriggerFromCeremony({
    code: DURESS_CODE,
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

/** A guest who enrolled a PIN and kept one item, then locked. */
async function sealedGuest(store: VaultStore): Promise<void> {
  await store.createGuest();
  await store.enrollPin(GUEST_PIN);
  await store.saveItem(createItem("login", "Guest keeps this"));
  await store.flushPendingWrites();
  store.lock();
  await vfsFlush();
}

beforeEach(() => {
  for (const tomb of [GUEST_TOMB, PERSONAL_TOMB, DECOY_SCRATCH_TOMB]) {
    kvDelete(tombFileKey(tomb, HEADER_PATH));
    kvDelete(tombFileKey(tomb, BODY_PATH));
  }
  clearEnrollmentStateForUnlock();
  resetFence();
});

afterEach(() => {
  clearEnrollmentStateForUnlock();
  clearActivePresentation();
  resetFence();
});

describe("duress decoy beside a sealed guest", () => {
  it("opens a decoy on the guest unlock screen without touching the sealed guest", async () => {
    const store = new VaultStore();
    await sealedGuest(store);
    const headerBefore = kvGet(GUEST_HEADER);
    const bodyBefore = kvGet(GUEST_BODY);
    expect(headerBefore).not.toBeNull();
    expect(bodyBefore).not.toBeNull();
    await armDecoyTrigger();

    store.rehydrate();
    expect(store.getSnapshot().status).toBe("locked");
    await expect(
      unlockWithPinAfterDuressGate(store, DURESS_CODE, {
        requireDurable: false,
      }),
    ).resolves.toBe("duress_session");

    // A fresh, guest-looking session, and the sealed guest is byte-for-byte whole.
    const decoy = store.getSnapshot();
    expect(decoy.status).toBe("unlocked");
    expect(decoy.guest).toBe(true);
    expect(decoy.tomb).toBe(GUEST_TOMB);
    expect(decoy.items).toHaveLength(0);
    await store.saveItem(createItem("login", "Written under duress"));
    await store.flushPendingWrites();
    await vfsFlush();
    expect(kvGet(GUEST_HEADER)).toBe(headerBefore);
    expect(kvGet(GUEST_BODY)).toBe(bodyBefore);

    // Locking the decoy leaves the sealed guest's unlock, and no trace in the list.
    store.lock();
    await vfsFlush();
    expect(listTombs()).not.toContain(DECOY_SCRATCH_TOMB);
    expect(kvGet(tombFileKey(DECOY_SCRATCH_TOMB, BODY_PATH))).toBeNull();
    const locked = store.getSnapshot();
    expect(locked.tomb).toBe(GUEST_TOMB);
    expect(locked.status).toBe("locked");
    expect(locked.header?.unlocks?.pin).toBeTruthy();
    expect(readLastVaultId()).toBe(GUEST_TOMB);

    // The guest's own PIN still opens the original items.
    clearEnrollmentStateForUnlock();
    await store.unlockWithPin(GUEST_PIN);
    expect(store.getSnapshot().items.map((item) => item.name)).toEqual([
      "Guest keeps this",
    ]);
  });

  it("keeps a sealed guest whole when the trigger fires beside the personal vault", async () => {
    const { header } = await createVault("correct horse battery staple");
    kvSet(PERSONAL_HEADER, JSON.stringify(header));
    const store = new VaultStore();
    await sealedGuest(store);
    const bodyBefore = kvGet(GUEST_BODY);
    await armDecoyTrigger();

    store.loadActiveProjectScope();
    expect(store.getSnapshot().tomb).toBe(PERSONAL_TOMB);
    await expect(
      unlockWithPinAfterDuressGate(store, DURESS_CODE, {
        requireDurable: false,
      }),
    ).resolves.toBe("duress_session");
    expect(store.getSnapshot().guest).toBe(true);
    expect(kvGet(GUEST_BODY)).toBe(bodyBefore);

    store.lock();
    clearEnrollmentStateForUnlock();
    await store.unlockWithPin(GUEST_PIN);
    expect(store.getSnapshot().items).toHaveLength(1);
    expect(kvGet(PERSONAL_HEADER)).toBe(JSON.stringify(header));
  });

  it("still runs a keyless guest decoy in the guest tomb", async () => {
    const store = new VaultStore();
    await armDecoyTrigger();
    store.prepareGuestUnlock();
    await expect(
      unlockWithPinAfterDuressGate(store, DURESS_CODE, {
        requireDurable: false,
      }),
    ).resolves.toBe("duress_session");
    expect(store.activeTomb()).toBe(GUEST_TOMB);
    expect(store.getSnapshot().guest).toBe(true);
    store.lock();
  });
});
