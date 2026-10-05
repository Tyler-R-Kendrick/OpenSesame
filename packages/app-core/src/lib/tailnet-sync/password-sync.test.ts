/**
 * A master password changed on one device opens the vault on the others
 * (ADR 0144), and nothing but a device holding the vault key can change it.
 */
import {
  WrongPasswordError,
  createItem,
  wrapVaultKeyWithPassword,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEALED_UNDER_ANOTHER_KEY } from "../vault/store-merge.js";
import { adoptSnapshot } from "./adopt.js";
import { type Device, as, device } from "./devices.fixture.js";
import { type MemoryDrive, PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";

const OLD = "correct horse battery staple";
const NEW = "a different, longer passphrase entirely";
const PIN = "48291573";
const NOW = Date.parse("2026-09-01T00:00:00.000Z");

function sync(on: Device, drive: MemoryDrive) {
  return as(on, () => syncOnce(on.store, PAIRING, drive));
}

function tick(minutes = 1): void {
  vi.setSystemTime(Date.now() + minutes * 60_000);
}

/** Set a device up from what the drive holds now, and open it with `password`. */
async function adopt(on: Device, drive: MemoryDrive, password: string) {
  const snapshot = drive.snapshot;
  if (!snapshot) throw new Error("the drive is empty");
  await as(on, async () => {
    expect(await adoptSnapshot(snapshot)).toBe("adopted");
    on.store.rehydrate();
    await on.store.unlock(password);
  });
}

/** Lock, then try `password`: true when it opens the vault. */
async function opensWith(on: Device, password: string): Promise<boolean> {
  return as(on, async () => {
    on.store.lock();
    try {
      await on.store.unlock(password);
      return true;
    } catch (error) {
      if (error instanceof WrongPasswordError) return false;
      throw error;
    }
  });
}

async function pairedDevices() {
  const drive = memoryDrive();
  const laptop = device("laptop");
  const phone = device("phone");
  await as(laptop, async () => {
    await laptop.store.create(OLD);
    await laptop.store.enrollPin(PIN);
    await laptop.store.saveItem(createItem("note", "bank"));
  });
  await sync(laptop, drive);
  await adopt(phone, drive, OLD);
  return { drive, laptop, phone };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a master password changed on one device", () => {
  it("opens the vault on the others, and the old one no longer does", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    tick();
    await as(laptop, () => laptop.store.changeMasterPassword(OLD, NEW));
    expect((await sync(laptop, drive)).pushed).toBe(true);
    await sync(phone, drive);

    expect(await opensWith(phone, OLD)).toBe(false);
    expect(await opensWith(phone, NEW)).toBe(true);
    // The phone's items are the vault's: same key, new password.
    expect(phone.store.getSnapshot().items.map((item) => item.name)).toEqual([
      "bank",
    ]);
    // In step afterwards: taking the change in writes nothing new.
    expect(await sync(phone, drive)).toMatchObject({ pushed: false });
  });

  it("is what a device set up later opens with", async () => {
    const { drive, laptop } = await pairedDevices();
    tick();
    await as(laptop, () => laptop.store.changeMasterPassword(OLD, NEW));
    await sync(laptop, drive);
    const tablet = device("tablet");
    await adopt(tablet, drive, NEW);
    expect(tablet.store.getSnapshot().status).toBe("unlocked");
  });

  it("keeps the PIN each device enrolled for itself", async () => {
    const { drive, laptop } = await pairedDevices();
    tick();
    await as(laptop, () => laptop.store.changeMasterPassword(OLD, NEW));
    await sync(laptop, drive);
    await as(laptop, async () => {
      laptop.store.lock();
      await laptop.store.unlockWithPin(PIN);
    });
    expect(laptop.store.getSnapshot().status).toBe("unlocked");
  });
});

describe("what a drive cannot do", () => {
  it("plant a password by rewriting the header it stores", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    tick();
    await as(laptop, () => laptop.store.saveItem(createItem("note", "more")));
    await sync(laptop, drive);
    const stored = drive.snapshot;
    if (!stored) throw new Error("the drive is empty");
    // A wrap of some other key under a password the drive chose.
    const planted = await wrapVaultKeyWithPassword(
      crypto.getRandomValues(new Uint8Array(32)),
      "the drive's own password",
    );
    drive.snapshot = {
      ...stored,
      header: { ...stored.header, kdf: planted.kdf, wrap: planted.wrap },
    };
    await sync(phone, drive);
    expect(await opensWith(phone, "the drive's own password")).toBe(false);
    expect(await opensWith(phone, OLD)).toBe(true);
  });
});

describe("a vault key rotated on another device", () => {
  it("replaces the drive's copy, and the others are told to set up again", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    tick();
    await as(laptop, () =>
      laptop.store.protection.rotateCompromisedRoot({ password: OLD }),
    );
    // The laptop cannot merge the copy under the old key; it replaces it.
    expect(await sync(laptop, drive)).toMatchObject({ pushed: true });
    expect(drive.snapshot?.rootEpoch).toBe(1);

    // The phone cannot open it, says so, and keeps its own vault meanwhile.
    await expect(sync(phone, drive)).rejects.toThrow(SEALED_UNDER_ANOTHER_KEY);
    expect(phone.store.getSnapshot().items.map((item) => item.name)).toEqual([
      "bank",
    ]);

    // Removed from the phone and set up from the drive, it opens again.
    await as(phone, () => phone.store.destroy());
    await adopt(phone, drive, OLD);
    expect(phone.store.getSnapshot().items.map((item) => item.name)).toEqual([
      "bank",
    ]);
    expect(await sync(phone, drive)).toMatchObject({ pushed: false });
  });
});

describe("a master password removed on one device", () => {
  it("is removed where another way in remains, and kept where it is the only one", async () => {
    const { drive, laptop, phone } = await pairedDevices();
    const tablet = device("tablet");
    await adopt(tablet, drive, OLD);
    // The tablet has a PIN of its own; the phone has only the password.
    await as(tablet, () => tablet.store.enrollPin(PIN));

    tick();
    await as(laptop, () => laptop.store.removePassword());
    await sync(laptop, drive);
    await sync(tablet, drive);
    await sync(phone, drive);

    expect(await opensWith(tablet, OLD)).toBe(false);
    await as(tablet, () => tablet.store.unlockWithPin(PIN));
    expect(tablet.store.getSnapshot().status).toBe("unlocked");
    // Never stranded: the phone keeps the one way in it has.
    expect(await opensWith(phone, OLD)).toBe(true);
  });
});
