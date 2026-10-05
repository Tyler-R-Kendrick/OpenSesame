/**
 * "Decoy with everyday items", end to end through the real unlock path with
 * real crypto, a real VaultStore and the real VFS: arm it through
 * `enableDuressCode`, type the code where a password is typed, and the decoy
 * opens holding the owner's items — and only those.
 */

import {
  createItem,
  itemSubtitle,
  searchMatches,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockWithPasswordAfterDuressGate } from "../../../screens/unlock/unlock-password-duress.js";
import { forgetDeviceIdentityKeyInFlightForTests } from "../../device-identity-key.js";
import { kvDelete, kvGet } from "../../kv.js";
import { ATTEMPTS_KEY, VaultStore } from "../../vault/store.js";
import {
  BODY_PATH,
  GUEST_TOMB,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  listTombs,
  tombFileKey,
  vfsFlush,
} from "../../vfs.js";
import { clearActivePresentation } from "../compartment/presentation-runtime.js";
import { duressSessionFence } from "../session/fence.js";
import { enableDuressCode } from "../settings/device-duress.js";
import { DECOY_SCRATCH_TOMB } from "../store/decoy-scratch.js";
import { clearEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";

/** Lets a test run the real seam, or the seam with its runners taken away. */
const seam = vi.hoisted(() => ({ runners: true }));
vi.mock("../settings/modes/effects.js", async (original) => {
  const real = await original<typeof import("../settings/modes/effects.js")>();
  return {
    ...real,
    runDuressEffects: vi.fn(
      (...args: Parameters<typeof real.runDuressEffects>) =>
        seam.runners ? real.runDuressEffects(...args) : Promise.resolve(),
    ),
  };
});

const PASSWORD = "correct horse battery staple";
const CODE = "739104628";
const OWN = "Real bank login";
const ITEMS = ["Netflix", "Wi-Fi at home", "Library card", "Gym"];
const tombs = [GUEST_TOMB, PERSONAL_TOMB, DECOY_SCRATCH_TOMB];

function resetFence(): void {
  const ids = [...duressSessionFence.readFence().activeIncidentIds];
  if (ids.length > 0) duressSessionFence.resolve(ids, true);
}

function raw(tomb: string): readonly [string | null, string | null] {
  return [
    kvGet(tombFileKey(tomb, HEADER_PATH)),
    kvGet(tombFileKey(tomb, BODY_PATH)),
  ];
}

/** A real personal vault with a real item, locked, with the decoy armed. */
async function armedVault(items: string): Promise<VaultStore> {
  const store = new VaultStore();
  await store.create(PASSWORD);
  await store.saveItem(createItem("login", OWN));
  await store.flushPendingWrites();
  store.lock();
  await vfsFlush();
  store.loadActiveProjectScope();
  expect(store.getSnapshot().tomb).toBe(PERSONAL_TOMB);
  const armed = await enableDuressCode({
    code: CODE,
    mode: "decoy_items",
    extras: { items },
    vaultRef: "vault-1",
    requireDurable: false,
  });
  expect(armed).toEqual({ ok: true });
  return store;
}

const typeCode = (store: VaultStore) =>
  unlockWithPasswordAfterDuressGate(store, CODE, { requireDurable: false });

beforeEach(async () => {
  seam.runners = true;
  await vfsFlush();
  for (const tomb of tombs) {
    for (const path of [
      BODY_PATH,
      HEADER_PATH,
      INDEX_PATH,
      MIGRATION_MARKER_PATH,
      "config/device-identity-key",
    ]) {
      kvDelete(tombFileKey(tomb, path));
    }
  }
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
  clearEnrollmentStateForUnlock();
  resetFence();
});

afterEach(async () => {
  await vfsFlush();
  clearEnrollmentStateForUnlock();
  clearActivePresentation();
  resetFence();
});

describe("decoy with everyday items, through unlock", () => {
  it("opens a decoy that holds the owner's items, and nothing of the vault", async () => {
    const store = await armedVault(ITEMS.join("\n"));
    const realBefore = raw(PERSONAL_TOMB);
    expect(realBefore[0]).not.toBeNull();
    expect(realBefore[1]).not.toBeNull();

    await expect(typeCode(store)).resolves.toBe("duress_session");

    const open = store.getSnapshot();
    expect(open.status).toBe("unlocked");
    expect(open.guest).toBe(true);
    expect(open.decoy).toBe(true);
    expect(open.items.map((item) => item.name)).toEqual(ITEMS);
    expect(open.items.map((item) => item.name)).not.toContain(OWN);
    // Ordinary items of an ordinary type, live and listed like any other.
    for (const item of open.items) {
      expect(item.kind).toBe("login");
      expect(item.deletedAt).toBeNull();
    }
    // The real tomb is byte-for-byte what it was: never read into, never written.
    await store.flushPendingWrites();
    await vfsFlush();
    expect(raw(PERSONAL_TOMB)).toEqual(realBefore);
    store.lock();
  });

  it("keeps secrets out of titles, subtitles and search, and out of the real vault", async () => {
    const store = await armedVault(ITEMS.join("\n"));
    await typeCode(store);
    const items = store.getSnapshot().items;
    expect(items).toHaveLength(ITEMS.length);
    for (const item of items) {
      if (item.kind !== "login") throw new Error("expected logins");
      expect(item.password.length).toBeGreaterThanOrEqual(12);
      expect(item.name).not.toContain(item.password);
      expect(itemSubtitle(item)).not.toContain(item.password);
      expect(searchMatches(item, item.password)).toBe(false);
      expect(searchMatches(item, item.name)).toBe(true);
    }
    expect(
      new Set(items.flatMap((i) => (i.kind === "login" ? [i.password] : [])))
        .size,
    ).toBe(ITEMS.length);
    store.lock();
  });

  it("shows the same passwords every time the code is typed, and a different set per arming", async () => {
    const store = await armedVault(ITEMS.join("\n"));
    const passwords = () =>
      store
        .getSnapshot()
        .items.map((item) => (item.kind === "login" ? item.password : ""));
    await typeCode(store);
    const first = passwords();
    store.lock();
    await vfsFlush();
    await typeCode(store);
    expect(passwords()).toEqual(first);
    store.lock();
    await vfsFlush();

    // The owner has cleared the incident the first use left, and arms again.
    resetFence();
    expect(
      await enableDuressCode({
        code: CODE,
        mode: "decoy_items",
        extras: { items: ITEMS.join("\n") },
        vaultRef: "vault-1",
        requireDurable: false,
      }),
    ).toEqual({ ok: true });
    await typeCode(store);
    expect(passwords()).not.toEqual(first);
    store.lock();
  });

  it("leaves nothing behind once the decoy locks, and the real password opens the real items", async () => {
    const store = await armedVault(ITEMS.join("\n"));
    const realBefore = raw(PERSONAL_TOMB);
    await typeCode(store);
    const shown = store
      .getSnapshot()
      .items.flatMap((item) =>
        item.kind === "login" ? [item.name, item.password] : [],
      );
    expect(shown).toHaveLength(ITEMS.length * 2);
    store.lock();
    await vfsFlush();

    expect(listTombs()).not.toContain(DECOY_SCRATCH_TOMB);
    expect(kvGet(tombFileKey(DECOY_SCRATCH_TOMB, BODY_PATH))).toBeNull();
    // A keyless guest's body is dropped by the next guest, not at lock; what
    // is left is ciphertext under a key that died with the session, so nothing
    // the decoy showed is readable from it.
    for (const key of [HEADER_PATH, BODY_PATH]) {
      for (const text of shown) {
        expect(kvGet(tombFileKey(GUEST_TOMB, key)) ?? "").not.toContain(text);
      }
    }
    expect(store.getSnapshot().items).toHaveLength(0);
    expect(raw(PERSONAL_TOMB)).toEqual(realBefore);

    clearEnrollmentStateForUnlock();
    store.loadActiveProjectScope();
    await store.unlock(PASSWORD);
    expect(store.getSnapshot().guest).toBe(false);
    expect(store.getSnapshot().items.map((item) => item.name)).toEqual([OWN]);
    store.lock();
  });

  it("runs beside a sealed guest in the scratch tomb, leaving the guest whole", async () => {
    const store = new VaultStore();
    await store.createGuest();
    await store.enrollPin("48291037");
    await store.saveItem(createItem("login", "Guest keeps this"));
    await store.flushPendingWrites();
    store.lock();
    await vfsFlush();
    const guestBefore = raw(GUEST_TOMB);
    expect(guestBefore[1]).not.toBeNull();
    expect(
      await enableDuressCode({
        code: CODE,
        mode: "decoy_items",
        extras: { items: ITEMS.join("\n") },
        vaultRef: "vault-1",
        requireDurable: false,
      }),
    ).toEqual({ ok: true });

    store.rehydrate();
    await expect(typeCode(store)).resolves.toBe("duress_session");
    expect(store.getSnapshot().items.map((item) => item.name)).toEqual(ITEMS);
    expect(store.getSnapshot().items.map((item) => item.name)).not.toContain(
      "Guest keeps this",
    );
    await store.flushPendingWrites();
    await vfsFlush();
    expect(raw(GUEST_TOMB)).toEqual(guestBefore);
    store.lock();
    await vfsFlush();
    expect(listTombs()).not.toContain(DECOY_SCRATCH_TOMB);
    expect(raw(GUEST_TOMB)).toEqual(guestBefore);
  });

  it("is proven to notice nothing happening: with the runner gone the decoy is empty", async () => {
    seam.runners = false;
    const store = await armedVault(ITEMS.join("\n"));
    await expect(typeCode(store)).resolves.toBe("duress_session");
    expect(store.getSnapshot().decoy).toBe(true);
    expect(store.getSnapshot().items).toHaveLength(0);
    store.lock();
  });
});
