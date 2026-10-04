/**
 * Writes that meet (ADR 0160 §5a): an edit from a tab that is behind never
 * drops the identity key another tab published, and deleting a vault never
 * waits on a key being published into it.
 */

/** @vitest-environment jsdom */
import {
  createItem,
  deviceKeyField,
  readDeviceIdentityKeyRecord,
} from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { genuineRecord } from "../__tests__/device-identity-records.js";
import { webLocksDouble } from "../__tests__/web-locks-double.js";
import { forgetDeviceIdentityKeyInFlightForTests } from "../device-identity-key.js";
import { kvDelete } from "../kv.js";
import {
  BODY_PATH,
  HEADER_PATH,
  INDEX_PATH,
  MIGRATION_MARKER_PATH,
  PERSONAL_TOMB,
  readSealedFile,
  tombFileKey,
  vfsFlush,
} from "../vfs.js";
import { bodyPortOf } from "./store-device-key.js";
import { ATTEMPTS_KEY, VaultStore } from "./store.js";

const PASSWORD = "correct horse battery staple";

function wipe(): void {
  for (const path of [
    BODY_PATH,
    HEADER_PATH,
    INDEX_PATH,
    MIGRATION_MARKER_PATH,
    "config/device-identity-key",
  ]) {
    kvDelete(tombFileKey(PERSONAL_TOMB, path));
  }
  kvDelete(ATTEMPTS_KEY);
  forgetDeviceIdentityKeyInFlightForTests();
}

beforeEach(async () => {
  await vfsFlush();
  wipe();
});

afterEach(async () => {
  await vfsFlush();
  vi.unstubAllGlobals();
});

async function settled(store: VaultStore): Promise<void> {
  await store.flushPendingWrites();
  await vfsFlush();
}

/** Tab A made the vault; tab B opened it as well, so A is the one that falls behind. */
async function twoTabs() {
  const a = new VaultStore();
  await a.create(PASSWORD);
  await settled(a);
  const b = new VaultStore();
  b.rehydrate();
  await b.unlock(PASSWORD);
  return { a, b };
}

async function nextVisit(): Promise<VaultStore> {
  const c = new VaultStore();
  c.rehydrate();
  await c.unlock(PASSWORD);
  return c;
}

describe("an ordinary edit from a tab that is behind", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { locks: webLocksDouble() });
  });

  it("does not drop the identity key the other tab published", async () => {
    const { a, b } = await twoTabs();
    const record = await genuineRecord(Date.now() - 1000);
    await bodyPortOf(b).publishKey(deviceKeyField(record));
    await settled(b);
    // A still holds the body it loaded: no key.
    expect(bodyPortOf(a).body().deviceIdentityKey).toBeUndefined();

    await a.saveItem(createItem("note", "Written in tab A"));
    await settled(a);

    const c = await nextVisit();
    expect(
      readDeviceIdentityKeyRecord(bodyPortOf(c).body().deviceIdentityKey)
        ?.keyId,
    ).toBe(record.keyId);
    expect(c.getSnapshot().items.map((item) => item.name)).toEqual([
      "Written in tab A",
    ]);
  });

  it("keeps the other tab's edit too, and seals a revision the header has not passed", async () => {
    const { a, b } = await twoTabs();
    await b.saveItem(createItem("note", "Written in tab B"));
    await settled(b);

    await a.saveItem(createItem("note", "Written in tab A"));
    await settled(a);

    const c = await nextVisit();
    expect(
      c
        .getSnapshot()
        .items.map((item) => item.name)
        .sort(),
    ).toEqual(["Written in tab A", "Written in tab B"]);
  });
});

describe("deleting a vault while a key is being published into it", () => {
  const deadline = (ms: number) =>
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms));

  it("settles both: neither waits on the other", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await settled(store);
    const field = deviceKeyField(await genuineRecord(Date.now() - 1000));

    const published = bodyPortOf(store).publishKey(field);
    // Let the publish take hold of the body lock before the delete is asked for.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const destroyed = store.destroy();

    const outcome = await Promise.race([
      Promise.allSettled([published, destroyed]),
      deadline(3000),
    ]);
    expect(outcome).not.toBe("hung");
    await vfsFlush();
    expect(readSealedFile(PERSONAL_TOMB, BODY_PATH)).toBeNull();
  });

  it("settles both when the delete is asked for first", async () => {
    const store = new VaultStore();
    await store.create(PASSWORD);
    await settled(store);
    const field = deviceKeyField(await genuineRecord(Date.now() - 1000));

    const destroyed = store.destroy();
    const published = bodyPortOf(store).publishKey(field);
    const outcome = await Promise.race([
      Promise.allSettled([published, destroyed]),
      deadline(3000),
    ]);
    expect(outcome).not.toBe("hung");
  });
});
