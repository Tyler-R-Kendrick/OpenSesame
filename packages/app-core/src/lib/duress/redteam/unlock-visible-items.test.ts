/**
 * "Show my vault without the items I hide", end to end through the real unlock
 * path with real crypto, a real VaultStore and the real VFS: the owner has the
 * vault open and arms the mode with two of its items left shown, the vault
 * locks, the code is typed where a password is typed, and the decoy that opens
 * holds sanitized copies of those two items — and nothing of any other item,
 * anywhere this device keeps state (ADR 0168).
 */

import {
  type AccountItem,
  accountTotp,
  createItem,
  manualPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { duressContinueSeams } from "../../../screens/unlock/unlock-duress-continue.js";
import { plainAccount } from "../../account.test-support.js";
import { producedPassword } from "../../account.test-support.js";
import { forgetDeviceIdentityKeyInFlightForTests } from "../../device-identity-key.js";
import { kvDelete, kvGet } from "../../kv.js";
import { ATTEMPTS_KEY, VaultStore } from "../../vault/store.js";
import { tombFileKey, vfsFlush } from "../../vfs.js";
import { clearActivePresentation } from "../compartment/presentation-runtime.js";
import { enableDuressCode } from "../settings/device-duress.js";
import { ENROLLMENT_STATE_KEY } from "../store/boot-keys.js";
import { clearEnrollmentStateForUnlock } from "../store/unlock-enrollment.js";
import {
  CODE,
  HIDDEN,
  HIDDEN_NOTE,
  PASSWORD,
  SEED,
  TOMB_PATHS,
  arm,
  everythingStored,
  hiddenStrings,
  leaksIn,
  lockIt,
  openVault,
  resetFence,
  shipped,
  tombs,
  typeCode,
} from "./unlock-visible-items.fixture.js";

beforeEach(async () => {
  duressContinueSeams.runEffects = shipped;
  await vfsFlush();
  for (const tomb of tombs) {
    for (const path of TOMB_PATHS) kvDelete(tombFileKey(tomb, path));
  }
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
  clearEnrollmentStateForUnlock();
  resetFence();
});

afterEach(async () => {
  duressContinueSeams.runEffects = shipped;
  await vfsFlush();
  clearEnrollmentStateForUnlock();
  clearActivePresentation();
  resetFence();
});

describe("visible items, through unlock", () => {
  it("opens a decoy holding sanitized copies of exactly the items left shown", async () => {
    const seeded = await openVault();
    const { store, netflix, authy } = seeded;
    // The trashed item and the passkey are named too, and still never copied.
    const armed = await arm(seeded, [
      netflix.id,
      authy.id,
      seeded.passkey.id,
      seeded.trashed.id,
    ]);
    expect(armed).toEqual({ ok: true });
    await lockIt(store);

    await expect(typeCode(store)).resolves.toBe("duress_session");
    const open = store.getSnapshot();
    expect(open.status).toBe("unlocked");
    expect(open.guest).toBe(true);
    expect(open.decoy).toBe(true);
    expect(open.items.map((item) => item.name)).toEqual([
      "Netflix",
      "Mail with 2FA",
    ]);

    const [first, second] = open.items;
    if (first?.kind !== "account" || second?.kind !== "account") {
      throw new Error("expected two accounts");
    }
    // Content that makes it look lived in comes across, dates as the vault holds them.
    const stored = seeded.all.find((item) => item.id === netflix.id);
    expect(first).toMatchObject({
      username: "me@example.test",
      notes: "family plan",
      favorite: true,
      createdAt: stored?.createdAt,
      updatedAt: stored?.updatedAt,
    });
    expect(producedPassword(first)).toBe("netflix-pw-4417");
    expect(first.uris.map((u) => [u.uri, u.match])).toEqual([
      ["https://netflix.example.test", "host"],
    ]);
    expect(first.fields.map((f) => [f.name, f.value])).toEqual([
      ["Profile", "Kids"],
    ]);
    // New ids everywhere, and nothing that ties a copy to the real item.
    const realIds = new Set(seeded.all.map((item) => item.id));
    for (const item of open.items) {
      expect(realIds.has(item.id)).toBe(false);
      expect(item.folderId).toBeNull();
      expect(item.deletedAt).toBeNull();
    }
    expect(first.uris[0]?.id).not.toBe("uri-1");
    expect(first.fields[0]?.id).not.toBe("f-1");
    // The seed does not travel.
    expect(accountTotp(second)).toBe("");
    expect(JSON.stringify(open)).not.toContain(SEED);
    store.lock();
  });

  it("puts no string of any hidden item anywhere: decoy, enrollment, journals, storage", async () => {
    const seeded = await openVault();
    await arm(seeded, [seeded.netflix.id, seeded.authy.id]);
    await lockIt(seeded.store);

    // The enrollment holds the copies, and holds them sealed under the code.
    const before = everythingStored();
    expect(leaksIn(before, hiddenStrings)).toEqual([]);
    expect(leaksIn(before, ["netflix-pw-4417", "family plan"])).toEqual([]);
    expect(kvGet(ENROLLMENT_STATE_KEY)).not.toBeNull();

    await typeCode(seeded.store);
    const decoy = JSON.stringify(seeded.store.getSnapshot());
    expect(leaksIn([decoy], hiddenStrings)).toEqual([]);
    expect(leaksIn([decoy], ["netflix-pw-4417"])).toEqual(["netflix-pw-4417"]);
    await seeded.store.flushPendingWrites();
    await vfsFlush();
    expect(leaksIn(everythingStored(), hiddenStrings)).toEqual([]);
    expect(
      leaksIn(everythingStored(), ["netflix-pw-4417", "mail-pw-6612"]),
    ).toEqual([]);
    seeded.store.lock();
    await vfsFlush();
    expect(leaksIn(everythingStored(), hiddenStrings)).toEqual([]);
  });

  it("can tell a leak when there is one: the scan finds a hidden string planted in storage", () => {
    expect(leaksIn([`x ${HIDDEN.password} y`], hiddenStrings)).toEqual([
      HIDDEN.password,
    ]);
  });

  it("keeps the real vault closed to the code: it still opens with its own password, whole", async () => {
    const seeded = await openVault();
    await arm(seeded, [seeded.netflix.id]);
    await lockIt(seeded.store);
    await typeCode(seeded.store);
    seeded.store.lock();
    await vfsFlush();

    clearEnrollmentStateForUnlock();
    seeded.store.loadActiveProjectScope();
    await seeded.store.unlock(PASSWORD);
    const names = seeded.store.getSnapshot().items.map((item) => item.name);
    expect(names).toContain(HIDDEN.name);
    expect(names).toContain(HIDDEN_NOTE.name);
    expect(seeded.store.getSnapshot().guest).toBe(false);
    seeded.store.lock();
  });

  it("does not show an item added after arming, and shows an edited one as it was", async () => {
    const seeded = await openVault();
    const { store, netflix } = seeded;
    await arm(seeded, [netflix.id]);
    await store.saveItem(plainAccount("Added later", "later-pw-1"));
    await store.saveItem({
      ...netflix,
      methods: [
        manualPassword(
          `${netflix.id}:password`,
          "netflix-edited-pw",
          new Date().toISOString(),
        ),
      ],
    });
    await store.flushPendingWrites();
    await lockIt(store);

    await typeCode(store);
    const open = store.getSnapshot().items;
    expect(open.map((item) => item.name)).toEqual(["Netflix"]);
    expect(JSON.stringify(open)).toContain("netflix-pw-4417");
    expect(JSON.stringify(open)).not.toContain("netflix-edited-pw");
    expect(JSON.stringify(open)).not.toContain("later-pw-1");
    store.lock();
  });

  it("shows the same copies every time the code is typed, under fresh ids each time", async () => {
    const seeded = await openVault();
    const { store } = seeded;
    await arm(seeded, [seeded.netflix.id, seeded.authy.id]);
    await lockIt(store);
    const view = () =>
      store
        .getSnapshot()
        .items.map((item) =>
          item.kind === "account" ? producedPassword(item) : "",
        );
    await typeCode(store);
    const first = view();
    store.lock();
    await vfsFlush();
    await typeCode(store);
    expect(view()).toEqual(first);
    store.lock();
  });

  it("is refused when nothing is left shown, or only what cannot be copied", async () => {
    const seeded = await openVault();
    expect(await arm(seeded, [])).toEqual({ ok: false, code: "failed" });
    expect(await arm(seeded, [seeded.passkey.id, seeded.trashed.id])).toEqual({
      ok: false,
      code: "failed",
    });
    // And with no items handed over, a mode that picks is not offered at all.
    expect(await arm(seeded, [seeded.netflix.id], [])).toEqual({
      ok: false,
      code: "failed",
    });
    expect(kvGet(ENROLLMENT_STATE_KEY)).toBeNull();
    seeded.store.lock();
  });

  it("says the picked items are too large rather than arming a code that would show nothing", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    const heavy: AccountItem[] = Array.from({ length: 12 }, (_, i) => ({
      ...createItem("account", `Heavy ${i}`),
      notes: "€".repeat(4000),
    }));
    for (const item of heavy) await store.saveItem(item);
    await store.flushPendingWrites();
    const result = await enableDuressCode({
      code: CODE,
      mode: "visible_items",
      extras: { shown: heavy.map((item) => item.id).join("\n") },
      items: store.getSnapshot().items,
      vaultRef: "vault-1",
      requireDurable: false,
    });
    expect(result).toEqual({ ok: false, code: "too_large" });
    store.lock();
  });

  it("is proven to notice nothing happening: with the runner gone the decoy is empty", async () => {
    duressContinueSeams.runEffects = async () => undefined;
    const seeded = await openVault();
    await arm(seeded, [seeded.netflix.id, seeded.authy.id]);
    await lockIt(seeded.store);
    await expect(typeCode(seeded.store)).resolves.toBe("duress_session");
    expect(seeded.store.getSnapshot().decoy).toBe(true);
    expect(seeded.store.getSnapshot().items).toHaveLength(0);
    seeded.store.lock();
  });
});
