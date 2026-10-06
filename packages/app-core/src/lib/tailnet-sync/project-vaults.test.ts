/**
 * Project vaults sync like the personal one (ADR 0144): a project made on one
 * device is set up on another beside the vaults it already holds, in the tomb
 * it was sealed in, and the two keep each other's changes from then on.
 */
import { createItem } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PERSONAL_PROJECT_ID,
  type PagesProject,
  projectSeams,
} from "../projects.js";
import {
  BODY_PATH,
  HEADER_PATH,
  PERSONAL_TOMB,
  listTombs,
  tombFileKey,
} from "../vfs.js";
import { adoptSnapshot, isProjectTomb } from "./adopt.js";
import { type Device, as, device, itemNames } from "./devices.fixture.js";
import { type MemoryDrive, PAIRING, memoryDrive } from "./drive.fixture.js";
import { syncOnce } from "./engine.js";
import { buildDriveSnapshot } from "./snapshot.js";

const PASSWORD = "correct horse battery staple";
const PERSONAL_PASSWORD = "an entirely separate personal passphrase";
const PROJECT = "prj_4f2a0c1e-9b7d-4e21-8a3c-5d6e7f809a1b";

const original = { ...projectSeams };
let active = PERSONAL_PROJECT_ID;

function project(id: string): PagesProject {
  return {
    id,
    name: id,
    kind: id === PERSONAL_PROJECT_ID ? "personal" : "standard",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

/** Point `on`'s store at `tomb`, as switching vaults does. */
function scopeTo(on: Device, tomb: string): void {
  active = tomb;
  on.store.lock();
  on.store.loadActiveProjectScope();
}

function sync(on: Device, drive: MemoryDrive) {
  return as(on, () => syncOnce(on.store, PAIRING, drive));
}

beforeEach(() => {
  active = PERSONAL_PROJECT_ID;
  Object.assign(projectSeams, { activeProject: () => project(active) });
});

afterEach(() => {
  Object.assign(projectSeams, original);
});

describe("isProjectTomb", () => {
  it("knows a project's tomb and nothing else", () => {
    expect(isProjectTomb(PROJECT)).toBe(true);
    for (const other of [PERSONAL_TOMB, "guest", "prj_x", "prj_../personal"])
      expect(isProjectTomb(other)).toBe(false);
  });
});

describe("a project vault on a second device", () => {
  it("lands beside the vault it already has, and syncs both ways", async () => {
    const drive = memoryDrive();
    const laptop = device("laptop");
    const phone = device("phone");

    // The laptop's project vault, with one item, on the drive.
    await as(laptop, async () => {
      scopeTo(laptop, PROJECT);
      await laptop.store.create(PASSWORD);
      await laptop.store.saveItem(createItem("note", "deploy keys"));
    });
    await sync(laptop, drive);
    expect(drive.snapshot?.tomb).toBe(PROJECT);

    // The phone already has its own personal vault, open.
    await as(phone, async () => {
      scopeTo(phone, PERSONAL_PROJECT_ID);
      await phone.store.create(PERSONAL_PASSWORD);
      await phone.store.saveItem(createItem("note", "my own"));
    });
    const personalBody = phone.files.get(tombFileKey(PERSONAL_TOMB, BODY_PATH));

    const snapshot = drive.snapshot;
    if (!snapshot) throw new Error("the drive is empty");
    await as(phone, async () => {
      expect(await adoptSnapshot(snapshot)).toBe("adopted");
      expect(listTombs()).toContain(PROJECT);
      // Setting up again is a no-op, not a second copy.
      expect(await adoptSnapshot(snapshot)).toBe("already-here");
    });
    expect(phone.files.has(tombFileKey(PROJECT, HEADER_PATH))).toBe(true);
    // The personal vault was never touched.
    expect(phone.files.get(tombFileKey(PERSONAL_TOMB, BODY_PATH))).toBe(
      personalBody,
    );

    // Switched to it, the project opens with its own password.
    await as(phone, async () => {
      scopeTo(phone, PROJECT);
      await phone.store.unlock(PASSWORD);
    });
    expect(itemNames(phone)).toEqual(["deploy keys"]);
    expect(await sync(phone, drive)).toMatchObject({ pushed: false });

    await as(phone, () =>
      phone.store.saveItem(createItem("note", "rotated on the phone")),
    );
    await sync(phone, drive);
    await sync(laptop, drive);
    expect(itemNames(laptop)).toEqual(["deploy keys", "rotated on the phone"]);

    // And the personal vault still opens, with what it had.
    await as(phone, async () => {
      scopeTo(phone, PERSONAL_PROJECT_ID);
      await phone.store.unlock(PERSONAL_PASSWORD);
    });
    expect(itemNames(phone)).toEqual(["my own"]);
  });

  it("refuses a tomb that already holds a different vault", async () => {
    const drive = memoryDrive();
    const laptop = device("laptop");
    const phone = device("phone");
    for (const on of [laptop, phone]) {
      await as(on, async () => {
        scopeTo(on, PROJECT);
        await on.store.create(PASSWORD);
      });
    }
    await sync(laptop, drive);
    const theirs = drive.snapshot;
    if (!theirs) throw new Error("the drive is empty");
    await as(phone, async () => {
      await expect(adoptSnapshot(theirs)).rejects.toThrow(
        "already holds a different vault",
      );
    });
  });

  it("refuses a snapshot naming a tomb no project could have", async () => {
    const laptop = device("laptop");
    await as(laptop, async () => {
      scopeTo(laptop, PROJECT);
      await laptop.store.create(PASSWORD);
    });
    const sealed = await as(laptop, () => laptop.store.sealedSnapshot());
    const forged = { ...buildDriveSnapshot(sealed), tomb: "prj_../personal" };
    await expect(adoptSnapshot(forged)).rejects.toThrow("cannot set up");
  });
});
