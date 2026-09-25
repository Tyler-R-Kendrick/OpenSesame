/**
 * Tailnet sync between two devices (ADR 0144), end to end inside the client:
 * two `VaultStore`s with separate storage, one drive with the daemon's
 * compare-and-set rule, and nothing shared between the devices but the drive.
 * The daemon's own side of the protocol is proven against the same exchanges
 * in `spec/conformance/vault-drive-protocol.json`.
 */
import {
  type VaultItem,
  createItem,
  itemTypeRegistry,
  syncInstalledTypes,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adoptSnapshot } from "./adopt.js";
import { type Device, as, device, itemNames } from "./devices.fixture.js";
import { type MemoryDrive, PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";
import { buildDriveSnapshot } from "./snapshot.js";

const PASSWORD = "correct horse battery staple";
const PIN = "48291573";

/** An installable item type; the registry it lands in is module-global. */
const LOCK_ID = "combination-lock";
/** `marketplace/item-types/optional/combination-lock.json`, inlined. */
const LOCK = JSON.stringify({
  apiVersion: "opensesame.dev/v1alpha1",
  kind: "VaultItemType",
  metadata: {
    id: "combination-lock",
    version: "1.0.0",
    publisher: "https://opensesame.dev",
  },
  spec: {
    title: "Combination lock",
    plural: "Combination locks",
    extension: ".lock",
    summary:
      "A padlock, safe, gate or door keypad and the combination that opens it.",
    categories: ["access"],
    sections: [
      {
        id: "lock",
        title: "Lock",
        fields: [
          { id: "location", type: "string", label: "Location", required: true },
          { id: "combination", type: "pin", label: "Combination" },
          {
            id: "kind",
            type: "select",
            label: "Kind",
            options: ["padlock", "safe", "keypad", "lockbox", "bike"],
          },
          { id: "notes", type: "multiline", label: "Notes" },
        ],
      },
    ],
    native: {
      secret: "combination",
      trailer: [
        { key: "location", field: "location" },
        { key: "kind", field: "kind" },
        { key: "notes", field: "notes" },
      ],
    },
    cxf: { credential: "custom-fields" },
    subtitle: ["location", "kind"],
    search: ["location", "kind"],
  },
});

let clock = Date.parse("2026-09-01T00:00:00.000Z");

/** Move time on, so the next write is unambiguously newer than the last. */
function tick(): void {
  clock += 60_000;
  vi.setSystemTime(clock);
}

function note(name: string, notes = ""): VaultItem {
  return { ...createItem("note", name), notes };
}

function sync(on: Device, drive: MemoryDrive) {
  return as(on, () => syncOnce(on.store, PAIRING, drive));
}

function byName(on: Device, name: string): VaultItem | undefined {
  return on.store.getSnapshot().items.find((item) => item.name === name);
}

/** What both devices must agree on: every item and folder, order aside. */
function contents(on: Device): string {
  const { items, folders } = on.store.getSnapshot();
  const sorted = <T extends { id: string }>(list: readonly T[]) =>
    [...list].sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify([sorted(items), sorted(folders)]);
}

/** A laptop with a vault and a PIN, paired; a phone set up from the drive. */
async function pairedDevices(...names: string[]) {
  const drive = memoryDrive();
  const laptop = device("laptop");
  const phone = device("phone");
  await as(laptop, async () => {
    await laptop.store.create(PASSWORD);
    await laptop.store.enrollPin(PIN);
    for (const name of names) {
      tick();
      await laptop.store.saveItem(note(name, `${name} secret notes`));
    }
  });
  await sync(laptop, drive);
  const snapshot = drive.snapshot;
  if (!snapshot) throw new Error("the laptop did not fill the drive");
  await as(phone, async () => {
    expect(await adoptSnapshot(snapshot)).toBe("adopted");
    phone.store.rehydrate();
    await phone.store.unlock(PASSWORD);
  });
  return { drive, laptop, phone };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
  syncInstalledTypes({});
});

describe("two devices, one drive", () => {
  it("sets the vault up on a second device with the first device's items", async () => {
    const { drive, laptop, phone } = await pairedDevices("bank", "email");
    expect(itemNames(phone)).toEqual(["bank", "email"]);
    expect(contents(phone)).toBe(contents(laptop));
    // The phone is already in step: nothing to pull, nothing to push.
    expect(await sync(phone, drive)).toMatchObject({
      pulled: false,
      pushed: false,
    });
  });

  it("keeps edits made on both devices while they were apart", async () => {
    const { drive, laptop, phone } = await pairedDevices("shared");
    const shared = byName(laptop, "shared");
    if (!shared) throw new Error("expected the shared item");

    tick();
    await as(laptop, () => laptop.store.saveItem(note("from the laptop")));
    tick();
    await as(phone, () => phone.store.saveItem(note("from the phone")));
    tick();
    await as(laptop, () =>
      laptop.store.saveItem({ ...shared, notes: "edited on the laptop" }),
    );
    tick();
    await as(phone, () =>
      phone.store.saveItem({ ...shared, notes: "edited on the phone" }),
    );

    await sync(laptop, drive);
    await sync(phone, drive);
    await sync(laptop, drive);

    for (const on of [laptop, phone]) {
      expect(itemNames(on)).toEqual([
        "from the laptop",
        "from the phone",
        "shared",
      ]);
      // The later edit of the same item wins on both sides.
      expect(byName(on, "shared")?.notes).toBe("edited on the phone");
    }
    expect(contents(laptop)).toBe(contents(phone));
  });

  it("carries a purge across, and a replayed older snapshot cannot undo it", async () => {
    const { drive, laptop, phone } = await pairedDevices("keep", "purge me");
    const before = structuredClone(drive.snapshot);
    const doomed = byName(phone, "purge me");
    if (!doomed || !before) throw new Error("expected the item and snapshot");

    tick();
    await as(phone, () => phone.store.purgeItem(doomed.id));
    await sync(phone, drive);
    await sync(laptop, drive);
    expect(itemNames(laptop)).toEqual(["keep"]);

    // A drive that replays the snapshot from before the purge is ignored on
    // the point that matters: the laptop keeps the purge and repairs the drive.
    drive.generation += 1;
    drive.snapshot = before;
    expect((await sync(laptop, drive)).pushed).toBe(true);
    expect(itemNames(laptop)).toEqual(["keep"]);
    await sync(phone, drive);
    expect(itemNames(phone)).toEqual(["keep"]);
  });

  it("deletes a folder everywhere and moves what was in it to the root", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    tick();
    const folder = await as(laptop, () => laptop.store.addFolder("Work"));
    tick();
    await as(laptop, () =>
      laptop.store.saveItem(
        { ...note("payroll"), folderId: folder.id },
        folder,
      ),
    );
    await sync(laptop, drive);
    await sync(phone, drive);
    expect(byName(phone, "payroll")?.folderId).toBe(folder.id);

    tick();
    await as(phone, () => phone.store.deleteFolder(folder.id));
    await sync(phone, drive);
    await sync(laptop, drive);

    for (const on of [laptop, phone]) {
      expect(on.store.getSnapshot().folders).toEqual([]);
      expect(byName(on, "payroll")?.folderId).toBeNull();
    }
    expect(contents(laptop)).toBe(contents(phone));
  });

  it("lands both devices' changes when they race for the drive", async () => {
    const { drive, laptop, phone } = await pairedDevices("base");
    tick();
    await as(phone, () => phone.store.saveItem(note("phone wins the race")));
    const phoneSnapshot = await as(phone, async () =>
      buildDriveSnapshot(await phone.store.sealedSnapshot()),
    );
    tick();
    await as(laptop, () => laptop.store.saveItem(note("laptop retries")));

    // The phone's write lands between the laptop's read and its write.
    drive.beforeWrite = () => {
      drive.generation += 1;
      drive.snapshot = phoneSnapshot;
    };
    const outcome = await sync(laptop, drive);
    expect(outcome).toMatchObject({ pulled: true, pushed: true });
    await sync(phone, drive);

    for (const on of [laptop, phone]) {
      expect(itemNames(on)).toEqual([
        "base",
        "laptop retries",
        "phone wins the race",
      ]);
    }
    expect(contents(laptop)).toBe(contents(phone));
  });

  it("never lets the drive see a name, a note or the PIN wrap", async () => {
    const { drive, laptop, phone } = await pairedDevices("bank", "email");
    tick();
    await as(phone, () => phone.store.saveItem(note("added on the phone")));
    await sync(phone, drive);
    await sync(laptop, drive);

    const stored = JSON.stringify(drive.snapshot);
    for (const secret of [
      "bank",
      "email",
      "secret notes",
      "added on the phone",
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(drive.snapshot?.header.unlocks?.pin).toBeUndefined();
    expect(drive.snapshot?.header.hint).toBeUndefined();
    // Each device still opens with its own methods: the phone has no PIN.
    expect(laptop.store.getSnapshot().header?.unlocks?.pin).toBeDefined();
    expect(phone.store.getSnapshot().header?.unlocks?.pin).toBeUndefined();
  });

  it("keeps a restore from the trash, and an unfavorite, after syncing", async () => {
    const { drive, laptop, phone } = await pairedDevices("restored", "starred");
    const restored = byName(laptop, "restored");
    const starred = byName(laptop, "starred");
    if (!restored || !starred) throw new Error("expected both items");

    tick();
    await as(laptop, () => laptop.store.trashItem(restored.id));
    await as(laptop, () => laptop.store.toggleFavorite(starred.id));
    await sync(laptop, drive);
    await sync(phone, drive);
    expect(byName(phone, "restored")?.deletedAt).not.toBeNull();
    expect(byName(phone, "starred")?.favorite).toBe(true);

    // Undone on the same device, after the drive already has the first change.
    tick();
    await as(laptop, () => laptop.store.restoreItem(restored.id));
    await as(laptop, () => laptop.store.toggleFavorite(starred.id));
    await sync(laptop, drive);
    await sync(phone, drive);

    for (const on of [laptop, phone]) {
      expect(byName(on, "restored")?.deletedAt).toBeNull();
      expect(byName(on, "starred")?.favorite).toBe(false);
    }
    expect(contents(laptop)).toBe(contents(phone));
  });

  it("keeps a folder rename, even to a name that sorts lower", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    tick();
    const folder = await as(laptop, () => laptop.store.addFolder("Work"));
    await sync(laptop, drive);
    await sync(phone, drive);

    tick();
    await as(phone, () => phone.store.renameFolder(folder.id, "Alpha"));
    await sync(laptop, drive);
    await sync(phone, drive);
    await sync(laptop, drive);

    for (const on of [laptop, phone]) {
      expect(on.store.getSnapshot().folders.map((f) => f.name)).toEqual([
        "Alpha",
      ]);
    }
  });

  it("keeps an item type uninstalled, until it is installed again", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    tick();
    expect(
      await as(laptop, () => laptop.store.installItemTypeDefinition(LOCK)),
    ).toMatchObject({ ok: true });
    await sync(laptop, drive);
    await sync(phone, drive);
    expect(itemTypeRegistry().has(LOCK_ID)).toBe(true);

    tick();
    await as(phone, () => phone.store.uninstallItemTypeDefinition(LOCK_ID));
    await sync(phone, drive);
    // The laptop still has it; syncing must not bring it back anywhere.
    await sync(laptop, drive);
    expect(itemTypeRegistry().has(LOCK_ID)).toBe(false);
    expect((await sync(phone, drive)).pulled).toBe(false);
    expect(itemTypeRegistry().has(LOCK_ID)).toBe(false);

    tick();
    await as(laptop, () => laptop.store.installItemTypeDefinition(LOCK));
    await sync(laptop, drive);
    await sync(phone, drive);
    expect(itemTypeRegistry().has(LOCK_ID)).toBe(true);
  });
});
